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
    const flags = await getChaosFlags();
    const cities = {};
    for (const flag of Object.values(flags)) {
      const lag = await measureReplicaLagMs(flag.cityCode);
      cities[flag.cityCode] = {
        primary_up: !flag.primaryDown,
        replica_up: !flag.replicaDown,
        extra_lag_ms: flag.extraLagMs,
        replica_lag_ms: lag,
        simulation: "SIMULATED",
      };
    }
    res.json({
      status: "ready",
      instance_id: reqInstanceId(_req),
      topology: describeTopology(),
      cities,
    });
  }),
);

router.get(
  "/admin/cluster-status",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  asyncRoute(async (_req, res) => {
    const flags = await getChaosFlags();
    const status = {};
    for (const flag of Object.values(flags)) {
      const { read, hot } = schemasFor(flag.cityCode);
      // Each city reads its own node, so one slow or dead city cannot make
      // cluster-status hang on the others.
      const cityPool = getPoolForCity(flag.cityCode);
      const [replication, inventory, lag] = await Promise.all([
        cityPool.query(
          `SELECT last_applied_event_id, last_applied_at
           FROM ${read}.replication_state WHERE id = TRUE`,
        ),
        cityPool.query(
          `SELECT count(*) FILTER (WHERE status = 'AVAILABLE')::int AS available,
                  count(*) FILTER (WHERE status IN ('RESERVED', 'DISPATCHED'))::int AS reserved
           FROM ${hot}.blood_units`,
        ),
        measureReplicaLagMs(flag.cityCode),
      ]);
      status[flag.cityCode] = {
        primary_up: !flag.primaryDown,
        replica_up: !flag.replicaDown,
        extra_lag_ms: flag.extraLagMs,
        replica_lag_ms: lag,
        last_applied_event_id: Number(replication.rows[0]?.last_applied_event_id ?? 0),
        available_units: inventory.rows[0].available,
        reserved_units: inventory.rows[0].reserved,
        updated_at: flag.updatedAt,
        // SIMULATED: flags represent router behavior, not killed database nodes.
        simulation: "SIMULATED",
        reachable: true,
      };
    }
    res.json({ instance_id: reqInstanceId(_req), topology: describeTopology(), cities: status });
  }),
);

function reqInstanceId(req) {
  return req.app.locals.instanceId;
}

export default router;