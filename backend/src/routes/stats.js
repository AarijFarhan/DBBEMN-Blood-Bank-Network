/**
 * Aggregated statistics for the analytics dashboards.
 *
 * `GET /stats/overview` and `GET /stats/timeseries` scatter-gather across the
 * city shards exactly the way search does: `Promise.allSettled` per city, a
 * failed shard becomes a partial answer instead of a failed request. The
 * emergency posture of the whole system is that a partial answer served
 * instantly beats no answer, and the dashboard is no exception — a system
 * admin watching Karachi's stock during a simulated outage still sees Lahore
 * and Islamabad.
 *
 * Reads hit the hot schema, not the simulated replica. These are counts for
 * operators, not reservation decisions, so reading the authoritative tables
 * avoids reporting numbers that lag the read model for no benefit.
 */
import { Router } from "express";
import { z } from "zod";
import { CITY_CODES, schemasFor } from "../db/shard-router.js";
import { getCatalogPool, getPoolForCity } from "../db/registry.js";
import { authenticate, requireRole } from "../middleware/auth.js";
import { asyncRoute } from "../middleware/errors.js";
import { parseQuery } from "../middleware/validate.js";
import { getActiveBank } from "../services/catalog.js";
import { getChaosFlags } from "../services/chaos.js";
import { publish, EVENT_TYPES } from "../lib/bus.js";
import { logger } from "../lib/logger.js";

const router = Router();
const log = logger.child({ module: "stats" });
const timeseriesQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(30),
});

const BLOOD_GROUPS = ["A", "B", "AB", "O"];
const RH_FACTORS = ["POS", "NEG"];

/** Cities this caller is allowed to aggregate over, resolved from their role. */
async function scopedCities(req) {
  if (req.user.role === "BLOODBANK_ADMIN") {
    const bank = await getActiveBank(req.user.blood_bank_id);
    return [bank.city_code.trim()];
  }
  return CITY_CODES;
}

/** Blood-bank scope for a bank admin; null means "no bank filter" (system view). */
function scopedBankId(req) {
  return req.user.role === "BLOODBANK_ADMIN" ? req.user.blood_bank_id : null;
}

router.get(
  "/stats/overview",
  authenticate,
  requireRole("HOSPITAL_ADMIN", "BLOODBANK_ADMIN", "SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => {
    const cities = await scopedCities(req);
    const bankId = scopedBankId(req);
    const flags = await getChaosFlags();

    // Scatter-gather: one round trip per city, isolated failure per city.
    const settled = await Promise.allSettled(
      cities.map(async (cityCode) => {
        const { hot, hist } = schemasFor(cityCode);
        const pool = getPoolForCity(cityCode);
        const [matrix, reservations, donations, transfusions] = await Promise.all([
          pool.query(
            `SELECT blood_group::text AS "bloodGroup", rh_factor::text AS "rhFactor",
                    component_type::text AS "componentType", status::text AS status,
                    count(*)::int AS count
             FROM ${hot}.blood_units
             WHERE ($1::uuid IS NULL OR blood_bank_id = $1)
             GROUP BY 1, 2, 3, 4`,
            [bankId],
          ),
          pool.query(
            `SELECT r.status::text AS status, r.urgency::text AS urgency, count(*)::int AS count
             FROM ${hot}.reservations r
             JOIN ${hot}.blood_units u ON u.unit_id = r.unit_id
             WHERE ($1::uuid IS NULL OR u.blood_bank_id = $1)
             GROUP BY 1, 2`,
            [bankId],
          ),
          pool.query(
            `SELECT count(*)::int AS count
             FROM ${hist}.donations
             WHERE collected_at >= now() - interval '30 days'
               AND ($1::uuid IS NULL OR blood_bank_id = $1)`,
            [bankId],
          ),
          pool.query(
            `SELECT count(*)::int AS count
             FROM ${hist}.transfusions
             WHERE transfused_at >= now() - interval '30 days'
               AND ($1::uuid IS NULL OR hospital_id IS NOT NULL)`,
            [],
          ),
        ]);
        return { cityCode, matrix, reservations, donations, transfusions };
      }),
    );

    const unavailableCities = [];
    const totals = Object.create(null);
    const byCity = Object.create(null);
    const groupTotals = Object.fromEntries(
      BLOOD_GROUPS.flatMap((group) => RH_FACTORS.map((rh) => [`${group}${rh}`, 0])),
    );
    const reservationsByStatus = Object.create(null);
    const reservationsByUrgency = Object.create(null);
    let donationsLast30Days = 0;
    let transfusionsLast30Days = 0;

    settled.forEach((outcome, index) => {
      const cityCode = cities[index];
      if (outcome.status === "rejected") {
        unavailableCities.push(cityCode);
        log.warn({ err: outcome.reason.message, cityCode }, "stats shard unavailable");
        return;
      }
      const { matrix, reservations, donations, transfusions } = outcome.value;
      const cityMatrix = Object.create(null);
      for (const row of matrix.rows) {
        const key = `${row.bloodGroup}${row.rhFactor}`;
        groupTotals[key] = (groupTotals[key] ?? 0) + row.count;
        totals[row.status] = (totals[row.status] ?? 0) + row.count;
        if (!cityMatrix[row.componentType]) cityMatrix[row.componentType] = Object.create(null);
        if (!cityMatrix[row.componentType][key]) cityMatrix[row.componentType][key] = 0;
        cityMatrix[row.componentType][key] += row.count;
      }
      for (const row of reservations.rows) {
        reservationsByStatus[row.status] = (reservationsByStatus[row.status] ?? 0) + row.count;
        reservationsByUrgency[row.urgency] = (reservationsByUrgency[row.urgency] ?? 0) + row.count;
      }
      donationsLast30Days += donations.rows[0]?.count ?? 0;
      transfusionsLast30Days += transfusions.rows[0]?.count ?? 0;
      byCity[cityCode] = { matrix: cityMatrix };
    });

    // Expiry pressure is computed per shard in SQL so the dashboard never has
    // to pull every row over the wire just to count the urgent ones.
    const expiringByCity = Object.create(null);
    await Promise.allSettled(
      cities
        .filter((cityCode) => !unavailableCities.includes(cityCode))
        .map(async (cityCode) => {
          const { hot } = schemasFor(cityCode);
          const result = await getPoolForCity(cityCode).query(
            `SELECT count(*) FILTER (WHERE expiry_date <= CURRENT_DATE + 7
                                     AND status IN ('AVAILABLE', 'QUARANTINE', 'RESERVED'))::int AS "expiring7d",
                    count(*) FILTER (WHERE expiry_date <= CURRENT_DATE
                                     AND status IN ('AVAILABLE', 'QUARANTINE', 'RESERVED'))::int AS "expired",
                    count(*) FILTER (WHERE status = 'AVAILABLE')::int AS available,
                    count(*) FILTER (WHERE status = 'RESERVED')::int AS reserved,
                    count(*) FILTER (WHERE status = 'QUARANTINE')::int AS quarantine
             FROM ${hot}.blood_units
             WHERE ($1::uuid IS NULL OR blood_bank_id = $1)`,
            [scopedBankId(req)],
          );
          expiringByCity[cityCode] = result.rows[0];
        }),
    );

    const flagsSummary = {};
    for (const cityCode of cities) {
      const flag = flags[cityCode];
      flagsSummary[cityCode] = {
        primaryUp: !flag?.primaryDown,
        replicaUp: !flag?.replicaDown,
        replicaLagMs: flag?.extraLagMs ?? 0,
      };
    }

    res.json({
      cities: Object.fromEntries(
        cities.map((cityCode) => [
          cityCode,
          {
            ...(byCity[cityCode] ?? { matrix: {} }),
            ...(expiringByCity[cityCode] ?? {}),
            health: flagsSummary[cityCode],
          },
        ]),
      ),
      totals: {
        unitsByStatus: totals,
        unitsByGroup: groupTotals,
        reservationsByStatus,
        reservationsByUrgency,
        donationsLast30Days,
        transfusionsLast30Days,
        expiring7d: Object.values(expiringByCity).reduce((sum, row) => sum + (row?.expiring7d ?? 0), 0),
      },
      unavailableCities,
      partial: unavailableCities.length > 0,
      scope: {
        role: req.user.role,
        cities,
        bankId,
      },
      generatedAt: new Date().toISOString(),
    });
  }),
);

router.get(
  "/stats/timeseries",
  authenticate,
  requireRole("HOSPITAL_ADMIN", "BLOODBANK_ADMIN", "SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => {
    const { days } = parseQuery(timeseriesQuerySchema, req.query);
    const cities = await scopedCities(req);
    const bankId = scopedBankId(req);

    const settled = await Promise.allSettled(
      cities.map(async (cityCode) => {
        const { hist } = schemasFor(cityCode);
        const result = await getPoolForCity(cityCode).query(
          `SELECT date_trunc('day', collected_at)::date AS day,
                  count(*)::int AS donations
           FROM ${hist}.donations
           WHERE collected_at >= now() - ($1::int * interval '1 day')
             AND ($2::uuid IS NULL OR blood_bank_id = $2)
           GROUP BY 1
           ORDER BY 1`,
          [days, bankId],
        );
        return result.rows;
      }),
    );

    const unavailableCities = [];
    const byDay = new Map();
    settled.forEach((outcome, index) => {
      if (outcome.status === "rejected") {
        unavailableCities.push(cities[index]);
        return;
      }
      for (const row of outcome.value) {
        const key = row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day);
        byDay.set(key, (byDay.get(key) ?? 0) + row.donations);
      }
    });

    // Fill gaps so the chart never draws a line through a missing day, which
    // would read as "zero donations" when it actually means "no data".
    const points = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const day = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
      points.push({ day, donations: byDay.get(day) ?? 0 });
    }

    res.json({
      points,
      days,
      unavailableCities,
      partial: unavailableCities.length > 0,
      generatedAt: new Date().toISOString(),
    });
  }),
);

export default router;
