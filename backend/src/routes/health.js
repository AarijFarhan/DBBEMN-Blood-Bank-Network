import { Router } from "express";
import { schemasFor } from "../db/shard-router.js";
import { describeTopology, getPoolForCity } from "../db/registry.js";
import { authenticate, requireRole } from "../middleware/auth.js";
import { asyncRoute } from "../middleware/errors.js";
import { getChaosFlags, measureReplicaLagMs } from "../services/chaos.js";

const router = Router();

router.get("/health/live", (_req, res) => {
  res.json({ status: "live" });
});

router.get(
  "/health/ready",
  asyncRoute(async (_req, res) => {
    try {
      const flags = await getChaosFlags();
      const cities = {};
      await Promise.all(
        Object.values(flags).map(async (flag) => {
          try {
            const lag = await measureReplicaLagMs(flag.cityCode);
            cities[flag.cityCode] = {
              primary_up: !flag.primaryDown,
              replica_up: !flag.replicaDown,
              extra_lag_ms: flag.extraLagMs,
              replica_lag_ms: lag,
              simulation: "SIMULATED",
            };
          } catch {
            cities[flag.cityCode] = {
              primary_up: !flag?.primaryDown,
              replica_up: !flag?.replicaDown,
              extra_lag_ms: flag?.extraLagMs ?? 0,
              replica_lag_ms: 0,
              simulation: "SIMULATED",
              reachable: false,
            };
          }
        }),
      );
      res.json({
        status: "ready",
        instance_id: reqInstanceId(_req),
        topology: describeTopology(),
        cities,
      });
    } catch (error) {
      res.status(200).json({
        status: "ready",
        instance_id: reqInstanceId(_req),
        topology: describeTopology(),
        cities: {},
        degraded: true,
      });
    }
  }),
);

router.get(
  "/admin/cluster-status",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  asyncRoute(async (_req, res) => {
    try {
      const flags = await getChaosFlags();
      const status = {};
      const cityCodes = Object.values(flags).map((flag) => flag.cityCode);
      await Promise.all(
        cityCodes.map(async (cityCode) => {
          const flag = flags[cityCode];
          const { read, hot } = schemasFor(cityCode);
          const cityPool = getPoolForCity(cityCode);
          try {
            const client = await Promise.race([
              cityPool.connect(),
              new Promise((_, reject) => setTimeout(() => reject(new Error("connect timeout")), 2000)),
            ]);
            try {
              const [replication, inventory, lag] = await Promise.all([
                Promise.race([
                  client.query(`SELECT last_applied_event_id, last_applied_at FROM ${read}.replication_state WHERE id = TRUE`),
                  new Promise((_, reject) => setTimeout(() => reject(new Error("replication timeout")), 2000)),
                ]),
                Promise.race([
                  client.query(
                    `SELECT count(*) FILTER (WHERE status = 'AVAILABLE')::int AS available,
                            count(*) FILTER (WHERE status IN ('RESERVED', 'DISPATCHED'))::int AS reserved
                     FROM ${hot}.blood_units`,
                  ),
                  new Promise((_, reject) => setTimeout(() => reject(new Error("inventory timeout")), 5000)),
                ]),
                measureReplicaLagMs(cityCode, client).catch(() => 0),
              ]);
              status[cityCode] = {
                primary_up: !flag?.primaryDown,
                replica_up: !flag?.replicaDown,
                extra_lag_ms: flag?.extraLagMs ?? 0,
                replica_lag_ms: lag,
                last_applied_event_id: Number(replication.rows?.[0]?.last_applied_event_id ?? 0),
                available_units: Number(inventory.rows?.[0]?.available ?? 0),
                reserved_units: Number(inventory.rows?.[0]?.reserved ?? 0),
                updated_at: flag?.updatedAt,
                simulation: "SIMULATED",
                reachable: true,
              };
            } finally {
              client.release();
            }
          } catch {
            status[cityCode] = {
              primary_up: !flag?.primaryDown,
              replica_up: !flag?.replicaDown,
              extra_lag_ms: flag?.extraLagMs ?? 0,
              replica_lag_ms: 0,
              last_applied_event_id: 0,
              available_units: 0,
              reserved_units: 0,
              updated_at: flag?.updatedAt,
              simulation: "SIMULATED",
              reachable: false,
            };
          }
        }),
      );
      res.json({ instance_id: reqInstanceId(_req), topology: describeTopology(), cities: status });
    } catch (error) {
      res.status(200).json({ instance_id: reqInstanceId(_req), topology: describeTopology(), cities: {}, degraded: true });
    }
  }),
);

function reqInstanceId(req) {
  return req.app.locals.instanceId;
}

export default router;