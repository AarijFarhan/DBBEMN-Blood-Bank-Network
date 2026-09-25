import { CITY_CODES, schemasFor } from "../db/shard-router.js";
import { connectWithRetry, pool, withSerializableRetry } from "../db/pool.js";
import { env } from "../config/env.js";

const MAINTENANCE_INTERVAL_MS = 30_000;
const REPLICA_INTERVAL_MS = 1_000;
const JOB_BATCH_SIZE = 250;
const REPLICA_BATCH_SIZE = 500;

export async function sweepCity(cityCode) {
  const { hot, read } = schemasFor(cityCode);
  return withSerializableRetry(async (client) => {
    const flag = await client.query(
      "SELECT primary_down FROM catalog.chaos_flags WHERE city_code = $1",
      [cityCode],
    );
    if (flag.rows[0]?.primary_down) return { skipped: "SIMULATED_PRIMARY_DOWN" };

    const expiredHolds = await client.query(
      `SELECT r.reservation_id, r.unit_id, u.expiry_date
       FROM ${hot}.reservations r
       JOIN ${hot}.blood_units u ON u.unit_id = r.unit_id
       WHERE r.status = 'ACTIVE' AND r.hold_expires_at <= now()
       ORDER BY r.hold_expires_at, r.reservation_id
       LIMIT $1
       FOR UPDATE OF r, u SKIP LOCKED`,
      [JOB_BATCH_SIZE],
    );
    let released = 0;
    for (const row of expiredHolds.rows) {
      const reservation = await client.query(
        `UPDATE ${hot}.reservations
         SET status = 'EXPIRED'
         WHERE reservation_id = $1 AND status = 'ACTIVE'
         RETURNING reservation_id`,
        [row.reservation_id],
      );
      if (reservation.rowCount === 0) continue;
      const unit = await client.query(
        `UPDATE ${hot}.blood_units
         SET status = CASE
           WHEN expiry_date > CURRENT_DATE THEN 'AVAILABLE'::common.unit_status_t
           ELSE 'EXPIRED'::common.unit_status_t
         END
         WHERE unit_id = $1 AND status = 'RESERVED'
         RETURNING unit_id`,
        [row.unit_id],
      );
      if (unit.rowCount > 0) released += 1;
    }

    const expiredUnits = await client.query(
      `SELECT unit_id
       FROM ${hot}.blood_units
       WHERE expiry_date <= CURRENT_DATE
         AND status IN ('QUARANTINE', 'AVAILABLE', 'RESERVED')
       ORDER BY expiry_date, unit_id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [JOB_BATCH_SIZE],
    );
    let expired = 0;
    for (const row of expiredUnits.rows) {
      await client.query(
        `UPDATE ${hot}.reservations
         SET status = 'EXPIRED'
         WHERE unit_id = $1 AND status = 'ACTIVE'`,
        [row.unit_id],
      );
      const unit = await client.query(
        `UPDATE ${hot}.blood_units
         SET status = 'EXPIRED'
         WHERE unit_id = $1
           AND expiry_date <= CURRENT_DATE
           AND status IN ('QUARANTINE', 'AVAILABLE', 'RESERVED')
         RETURNING unit_id`,
        [row.unit_id],
      );
      if (unit.rowCount > 0) expired += 1;
    }

    const replicaState = await client.query(
      `SELECT last_applied_event_id
       FROM ${read}.replication_state
       WHERE id = TRUE
       FOR UPDATE SKIP LOCKED`,
    );
    let archivedOutboxRows = 0;
    if (replicaState.rowCount > 0) {
      const archived = await client.query(
        `DELETE FROM ${hot}.outbox
         WHERE event_id <= $1 AND created_at < now() - interval '1 day'`,
        [replicaState.rows[0].last_applied_event_id],
      );
      archivedOutboxRows = archived.rowCount;
    }
    return { released, expired, archivedOutboxRows };
  });
}

export async function runMaintenanceOnce() {
  const results = await Promise.allSettled(CITY_CODES.map((city) => sweepCity(city)));
  return results.map((result, index) => ({
    cityCode: CITY_CODES[index],
    ...(result.status === "fulfilled" ? result.value : { error: result.reason.message }),
  }));
}

export async function applyReplicaBatch(cityCode, limit = REPLICA_BATCH_SIZE) {
  const { hot, read } = schemasFor(cityCode);
  const client = await connectWithRetry();
  try {
    await client.query("BEGIN");
    const flags = await client.query(
      `SELECT replica_down, extra_lag_ms
       FROM catalog.chaos_flags WHERE city_code = $1`,
      [cityCode],
    );
    if (!flags.rows[0] || flags.rows[0].replica_down) {
      await client.query("COMMIT");
      return { applied: 0, skipped: "SIMULATED_REPLICA_DOWN" };
    }

    await client.query(
      `INSERT INTO ${read}.replication_state (id)
       VALUES (TRUE)
       ON CONFLICT (id) DO NOTHING`,
    );
    const state = await client.query(
      `SELECT last_applied_event_id
       FROM ${read}.replication_state
       WHERE id = TRUE
       FOR UPDATE SKIP LOCKED`,
    );
    if (state.rowCount === 0) {
      await client.query("COMMIT");
      return { applied: 0, skipped: "APPLIER_BUSY" };
    }

    const events = await client.query(
      `SELECT event_id, payload
       FROM ${hot}.outbox
       WHERE event_id > $1
         AND created_at <= now()
           - (($2::int + $3::int) * interval '1 millisecond')
       ORDER BY event_id
       LIMIT $4
       FOR UPDATE SKIP LOCKED`,
      [
        state.rows[0].last_applied_event_id,
        env.replicaLagMs,
        flags.rows[0].extra_lag_ms,
        limit,
      ],
    );

    for (const event of events.rows) {
      const payload = event.payload;
      if (payload.status === "AVAILABLE" && new Date(payload.expiry_date) > new Date()) {
        await client.query(
          `INSERT INTO ${read}.units_search
             (unit_id, blood_bank_id, blood_group, rh_factor, component_type,
              volume_ml, collected_on, expiry_date)
           VALUES ($1, $2, $3::common.blood_group_t, $4::common.rh_t,
                   $5::common.component_t, $6, $7::date, $8::date)
           ON CONFLICT (unit_id) DO UPDATE SET
             blood_bank_id = EXCLUDED.blood_bank_id,
             blood_group = EXCLUDED.blood_group,
             rh_factor = EXCLUDED.rh_factor,
             component_type = EXCLUDED.component_type,
             volume_ml = EXCLUDED.volume_ml,
             collected_on = EXCLUDED.collected_on,
             expiry_date = EXCLUDED.expiry_date`,
          [
            payload.unit_id,
            payload.blood_bank_id,
            payload.blood_group,
            payload.rh_factor,
            payload.component_type,
            payload.volume_ml,
            payload.collected_on,
            payload.expiry_date,
          ],
        );
      } else {
        await client.query(
          `DELETE FROM ${read}.units_search WHERE unit_id = $1`,
          [payload.unit_id],
        );
      }
      await client.query(
        `UPDATE ${read}.replication_state
         SET last_applied_event_id = $1, last_applied_at = now()
         WHERE id = TRUE`,
        [event.event_id],
      );
    }

    await client.query("COMMIT");
    return { applied: events.rowCount };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function applyReplicasOnce() {
  const results = await Promise.allSettled(
    CITY_CODES.map((city) => applyReplicaBatch(city)),
  );
  return results.map((result, index) => ({
    cityCode: CITY_CODES[index],
    ...(result.status === "fulfilled" ? result.value : { error: result.reason.message }),
  }));
}

export function startBackgroundJobs(logger) {
  let maintenanceRunning = false;
  let replicaRunning = false;
  const runMaintenance = async () => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      const result = await runMaintenanceOnce();
      logger.info({ result }, "reservation and expiry sweep complete");
    } catch (error) {
      logger.error({ err: error }, "reservation and expiry sweep failed");
    } finally {
      maintenanceRunning = false;
    }
  };
  const runReplicas = async () => {
    if (replicaRunning) return;
    replicaRunning = true;
    try {
      const result = await applyReplicasOnce();
      const applied = result.filter((row) => row.applied > 0);
      if (applied.length > 0) logger.info({ applied }, "SIMULATED replica batch applied");
      const errors = result.filter((row) => row.error);
      if (errors.length > 0) logger.error({ errors }, "SIMULATED replica apply failed");
    } finally {
      replicaRunning = false;
    }
  };

  void runMaintenance();
  void runReplicas();
  const maintenanceTimer = setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);
  const replicaTimer = setInterval(runReplicas, REPLICA_INTERVAL_MS);
  return () => {
    clearInterval(maintenanceTimer);
    clearInterval(replicaTimer);
  };
}

export async function closeJobPool() {
  await pool.end();
}