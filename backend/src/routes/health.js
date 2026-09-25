import { Router } from "express";
import { schemasFor } from "../db/shard-router.js";
import { pool } from "../db/pool.js";
import { authenticate, requireRole } from "../middleware/auth.js";
import { asyncRoute } from "../middleware/errors.js";

const router = Router();

router.get("/health/live", (_req, res) => {
  res.json({ status: "live" });
});

router.get(
  "/health/ready",
  asyncRoute(async (_req, res) => {
    const flags = await pool.query(
      `SELECT city_code, primary_down, replica_down, extra_lag_ms
       FROM catalog.chaos_flags
       ORDER BY city_code`,
    );
    const cities = {};
    for (const row of flags.rows) {
      const cityCode = row.city_code.trim();
      const { hot, read } = schemasFor(cityCode);
      const lag = await pool.query(
        `SELECT COALESCE(
           ceil(EXTRACT(EPOCH FROM (now() - min(o.created_at))) * 1000),
           0
         )::int AS lag_ms
         FROM (
           SELECT COALESCE(
             (SELECT last_applied_event_id
              FROM ${read}.replication_state WHERE id = TRUE),
             0
           ) AS last_event_id
         ) s
         LEFT JOIN ${hot}.outbox o ON o.event_id > s.last_event_id`,
      );
      cities[cityCode] = {
        primary_up: !row.primary_down,
        replica_up: !row.replica_down,
        replica_lag_ms: lag.rows[0].lag_ms,
      };
    }
    res.json({
      status: "ready",
      instance_id: reqInstanceId(_req),
      cities,
    });
  }),
);

router.get(
  "/admin/cluster-status",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  asyncRoute(async (_req, res) => {
    const flags = await pool.query(
      `SELECT city_code, primary_down, replica_down, extra_lag_ms, updated_at
       FROM catalog.chaos_flags
       ORDER BY city_code`,
    );
    const status = {};
    for (const row of flags.rows) {
      const cityCode = row.city_code.trim();
      const { read, hot } = schemasFor(cityCode);
      const [replication, inventory, lag] = await Promise.all([
        pool.query(
          `SELECT last_applied_event_id, last_applied_at
           FROM ${read}.replication_state WHERE id = TRUE`,
        ),
        pool.query(
          `SELECT count(*) FILTER (WHERE status = 'AVAILABLE')::int AS available,
                  count(*) FILTER (WHERE status IN ('RESERVED', 'DISPATCHED'))::int AS reserved
           FROM ${hot}.blood_units`,
        ),
        pool.query(
          `SELECT COALESCE(
             ceil(EXTRACT(EPOCH FROM (now() - min(o.created_at))) * 1000),
             0
           )::int AS lag_ms
           FROM (
             SELECT COALESCE(
               (SELECT last_applied_event_id
                FROM ${read}.replication_state WHERE id = TRUE),
               0
             ) AS last_event_id
           ) s
           LEFT JOIN ${hot}.outbox o ON o.event_id > s.last_event_id`,
        ),
      ]);
      status[cityCode] = {
        primary_up: !row.primary_down,
        replica_up: !row.replica_down,
        extra_lag_ms: Number(row.extra_lag_ms),
        replica_lag_ms: lag.rows[0].lag_ms,
        last_applied_event_id: Number(replication.rows[0]?.last_applied_event_id ?? 0),
        available_units: inventory.rows[0].available,
        reserved_units: inventory.rows[0].reserved,
        updated_at: row.updated_at,
        // SIMULATED: flags represent router behavior, not killed database nodes.
        simulation: "SIMULATED",
      };
    }
    res.json({ instance_id: reqInstanceId(_req), cities: status });
  }),
);

function reqInstanceId(req) {
  return req.app.locals.instanceId;
}

export default router;