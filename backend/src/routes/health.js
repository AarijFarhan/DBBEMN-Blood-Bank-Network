import { Router } from "express";
import { CITY_CODES, schemasFor } from "../db/shard-router.js";
import { describeTopology, getCatalogPool, getPoolForCity, getReplicaPoolForCity } from "../db/registry.js";
import { authenticate, requireRole } from "../middleware/auth.js";
import { asyncRoute } from "../middleware/errors.js";
import { getChaosFlags, measureReplicaLagMs } from "../services/chaos.js";

const router = Router();
const PROBE_TIMEOUT_MS = 3000;

async function inspectPostgres(pool, { primaryWalLsn = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${PROBE_TIMEOUT_MS}`);
    const result = await client.query(
      `SELECT current_setting('server_version') AS server_version,
              current_database() AS database_name,
              pg_is_in_recovery() AS is_standby,
              current_setting('transaction_read_only')::boolean AS read_only,
              pg_postmaster_start_time() AS started_at,
              current_setting('max_connections')::int AS max_connections,
              (SELECT count(*)::int
                 FROM pg_stat_activity
                WHERE datname = current_database()) AS connections,
              CASE WHEN pg_is_in_recovery() THEN NULL
                   ELSE pg_current_wal_lsn()::text
              END AS current_wal_lsn,
              CASE WHEN pg_is_in_recovery() THEN NULL
                   ELSE (SELECT count(*)::int
                           FROM pg_stat_replication
                          WHERE state = 'streaming')
              END AS streaming_replicas,
              CASE WHEN pg_is_in_recovery() THEN
                (SELECT status FROM pg_stat_wal_receiver LIMIT 1)
              ELSE NULL END AS wal_receiver_status,
              CASE WHEN pg_is_in_recovery() THEN
                pg_last_wal_replay_lsn()::text
              ELSE NULL END AS replay_lsn,
              CASE WHEN pg_is_in_recovery() AND pg_last_xact_replay_timestamp() IS NOT NULL
                THEN GREATEST(
                  0,
                  floor(EXTRACT(EPOCH FROM
                    (clock_timestamp() - pg_last_xact_replay_timestamp())) * 1000)
                )::bigint
                ELSE NULL
              END AS replay_delay_ms,
              CASE WHEN pg_is_in_recovery() AND $1::pg_lsn IS NOT NULL
                         AND pg_last_wal_replay_lsn() IS NOT NULL
                THEN GREATEST(
                  0,
                  pg_wal_lsn_diff($1::pg_lsn, pg_last_wal_replay_lsn())
                )::bigint
                ELSE NULL
              END AS replay_lag_bytes`,
      [primaryWalLsn],
    );
    return result.rows[0];
  } finally {
    try {
      await client.query("RESET statement_timeout");
    } catch {
      // A failed connection is discarded when released.
    }
    client.release();
  }
}

function probeErrorCode(error) {
  return typeof error?.code === "string" ? error.code : "PROBE_FAILED";
}

function nodeTelemetry(server, expectedStandby) {
  const isStandby = server.is_standby;
  const roleMatches = isStandby === expectedStandby;
  const streaming = server.wal_receiver_status === "streaming";
  return {
    status: !roleMatches
      ? "wrong_role"
      : expectedStandby && !streaming
        ? "not_streaming"
        : "up",
    configured: true,
    role: isStandby ? "standby" : "primary",
    read_only: server.read_only,
    server_version: server.server_version,
    database_name: server.database_name,
    started_at: server.started_at,
    uptime_seconds: server.started_at
      ? Math.max(0, Math.floor((Date.now() - new Date(server.started_at).getTime()) / 1000))
      : null,
    connections: Number(server.connections),
    max_connections: Number(server.max_connections),
    streaming_replicas: server.streaming_replicas === null
      ? null
      : Number(server.streaming_replicas),
    current_wal_lsn: server.current_wal_lsn,
    wal_receiver_status: server.wal_receiver_status,
    replay_delay_ms: server.replay_delay_ms === null
      ? null
      : Number(server.replay_delay_ms),
    replay_lag_bytes: server.replay_lag_bytes === null
      ? null
      : Number(server.replay_lag_bytes),
  };
}

async function probeNode(pool, expectedStandby, primaryWalLsn, primaryDatabaseName = null) {
  try {
    const server = await inspectPostgres(pool, { primaryWalLsn });
    const telemetry = nodeTelemetry(server, expectedStandby);
    if (!expectedStandby && server.read_only) {
      telemetry.status = "read_only";
    } else if (expectedStandby && primaryDatabaseName && server.database_name !== primaryDatabaseName) {
      telemetry.status = "wrong_database";
    }
    return telemetry;
  } catch (error) {
    return {
      status: "unavailable",
      configured: true,
      error_code: probeErrorCode(error),
      role: null,
    };
  }
}

async function estimateInventory(cityCode) {
  const { hot } = schemasFor(cityCode);
  const result = await getPoolForCity(cityCode).query(
    `SELECT
       CASE WHEN s.most_common_vals IS NULL THEN NULL
         ELSE round(GREATEST(c.reltuples, 0) *
           COALESCE((s.most_common_freqs::text::real[])[array_position(s.most_common_vals::text::text[], 'AVAILABLE')], 0))
       END::bigint AS available,
       CASE WHEN s.most_common_vals IS NULL THEN NULL
         ELSE round(GREATEST(c.reltuples, 0) * (
           COALESCE((s.most_common_freqs::text::real[])[array_position(s.most_common_vals::text::text[], 'RESERVED')], 0)
           + COALESCE((s.most_common_freqs::text::real[])[array_position(s.most_common_vals::text::text[], 'DISPATCHED')], 0)
         ))
       END::bigint AS reserved
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_stats s
       ON s.schemaname = n.nspname
      AND s.tablename = c.relname
      AND s.attname = 'status'
     WHERE n.nspname = $1 AND c.relname = 'blood_units'`,
    [hot],
  );
  return {
    available: result.rows[0]?.available === null || result.rows[0]?.available === undefined
      ? null
      : Number(result.rows[0].available),
    reserved: result.rows[0]?.reserved === null || result.rows[0]?.reserved === undefined
      ? null
      : Number(result.rows[0].reserved),
  };
}

router.get("/health/live", (_req, res) => {
  res.json({ status: "live" });
});

router.get(
  "/health/ready",
  asyncRoute(async (_req, res) => {
    const cities = {};
    const catalog = await probeNode(getCatalogPool(), false, null);
    await Promise.all(CITY_CODES.map(async (cityCode) => {
      const primary = await probeNode(getPoolForCity(cityCode), false, null);
      const { current_wal_lsn: primaryWalLsn, ...primaryTelemetry } = primary;
      const replicaPool = getReplicaPoolForCity(cityCode);
      const replica = replicaPool
        ? primary.status === "up"
          ? await probeNode(replicaPool, true, primaryWalLsn ?? null, primary.database_name)
          : { status: "not_checked", configured: true, role: null }
        : { status: "not_configured", configured: false, role: null };

      cities[cityCode] = {
        primary: primaryTelemetry,
        replica,
        reachable: primary.status === "up",
        updated_at: new Date().toISOString(),
      };
    }));

    const unavailableCities = CITY_CODES.filter(
      (cityCode) => cities[cityCode].primary.status !== "up",
    );
    const unavailableNodes = [
      ...(catalog.status === "up" ? [] : ["catalog"]),
      ...unavailableCities,
    ];
    const status = unavailableNodes.length ? "degraded" : "ready";
    res.status(unavailableNodes.length ? 503 : 200).json({
      status,
      instance_id: reqInstanceId(_req),
      topology: describeTopology(),
      catalog,
      cities,
      unavailableCities,
      unavailableNodes,
    });
  }),
);

router.get(
  "/admin/chaos",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  asyncRoute(async (_req, res) => {
    const flags = await getChaosFlags();
    res.json({
      flags: Object.fromEntries(
        Object.entries(flags).map(([cityCode, flag]) => [
          cityCode,
          {
            primary_down: flag.primaryDown,
            replica_down: flag.replicaDown,
            extra_lag_ms: flag.extraLagMs,
            updated_at: flag.updatedAt,
          },
        ]),
      ),
      simulation: "SIMULATED",
    });
  }),
);

router.get(
  "/admin/cluster-status",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  asyncRoute(async (_req, res) => {
    const status = {};
    await Promise.all(CITY_CODES.map(async (cityCode) => {
      const primary = await probeNode(getPoolForCity(cityCode), false, null);
      const { current_wal_lsn: primaryWalLsn, ...primaryTelemetry } = primary;
      const replicaPool = getReplicaPoolForCity(cityCode);
      const replica = replicaPool
        ? primary.status === "up"
          ? await probeNode(replicaPool, true, primaryWalLsn ?? null, primary.database_name)
          : { status: "not_checked", configured: true, role: null }
        : { status: "not_configured", configured: false, role: null };

      let inventory = { available: null, reserved: null };
      let inventoryError = null;
      if (primary.status === "up") {
        try {
          inventory = await estimateInventory(cityCode);
        } catch (error) {
          inventoryError = probeErrorCode(error);
        }
      }

      status[cityCode] = {
        primary: primaryTelemetry,
        replica,
        available_units: inventory.available,
        reserved_units: inventory.reserved,
        inventory_approximate: true,
        inventory_error: inventoryError,
        reachable: primary.status === "up",
        updated_at: new Date().toISOString(),
      };
    }));
    res.json({ instance_id: reqInstanceId(_req), topology: describeTopology(), cities: status });
  }),
);

function reqInstanceId(req) {
  return req.app.locals.instanceId;
}

export default router;