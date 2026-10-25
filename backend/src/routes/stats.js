/**
 * Aggregated statistics for the analytics dashboards.
 *
 * `GET /stats/overview` and `GET /stats/timeseries` scatter-gather across the
 * city shards exactly the way search does: `Promise.allSettled` per city, a
 * failed shard becomes a partial answer instead of a failed request. The
 * emergency posture of the whole system is that a partial answer served
 * instantly beats no answer, and the dashboard is no exception â€” a system
 * admin watching Karachi's stock during a simulated outage still sees Lahore
 * and Islamabad.
 *
 * Reads hit the hot schema, not the simulated replica. These are counts for
 * operators, not reservation decisions, so reading the authoritative tables
 * avoids reporting numbers that lag the read model for no benefit.
 */
import { Router } from "express";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { CITY_CODES, schemasFor } from "../db/shard-router.js";
import { getCatalogPool, getPoolForCity } from "../db/registry.js";
import {
  cacheDeleteIfValue,
  cacheGet,
  cacheMode,
  cacheSet,
  cacheSetIfAbsent,
  inventoryVersions,
  isSharedCache,
  versionToken,
} from "../cache/store.js";
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

/**
 * Per-shard statement budget. Without it a saturated shard (Karachi's disk
 * waits for minutes) holds a pool slot and the whole scatter-gather response
 * hangs forever, so the dashboard never gets the nine shards that did answer.
 * A timed-out city is reported as unavailable, exactly like a failed connect.
 */
const SHARD_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.STATS_SHARD_TIMEOUT_MS);
  // Return partial shard results before nginx's 60-second proxy timeout.
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 45000) : 45000;
})();

/** Run work on a city client whose statements are bounded by SHARD_TIMEOUT_MS. */
async function withCityStatsClient(cityCode, work) {
  const client = await getPoolForCity(cityCode).connect();
  try {
    await client.query(`SET statement_timeout = ${Math.max(1000, SHARD_TIMEOUT_MS)}`);
    return await work(client);
  } finally {
    try {
      await client.query("RESET statement_timeout");
    } catch {
      // Connection already gone; release discards it.
    }
    client.release();
  }
}

/**
 * Per-city cache, because the aggregates scan every unit row on that shard.
 *
 * Ten shards on one spinning disk cannot answer in parallel: five of them hold
 * 5M units each, so a cold overview was taking 30-45s and timing shards out.
 * These analytics are not used for clinical decisions, so their cache is
 * deliberately independent of inventory versions. A stock update should not
 * force another full-table aggregation before the dashboard can render.
 */
const STATS_CACHE_TTL_SECONDS = 900;
const STATS_FRESH_MS = 60_000;
const STATS_REFRESH_LOCK_TTL_SECONDS = 300;
const cityInflight = new Map();
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function cityCacheKey(cityCode, bankId) {
  return `stats:city:v3:${cityCode}:${bankId ?? "all"}`;
}

const INVENTORY_GROUPS = ["A", "B", "AB", "O"];
const INVENTORY_RH_FACTORS = ["POS", "NEG"];
const INVENTORY_COMPONENTS = ["WHOLE_BLOOD", "PRBC", "PLATELETS", "PLASMA"];
const INVENTORY_STATUSES = [
  "AVAILABLE",
  "RESERVED",
  "QUARANTINE",
  "DISPATCHED",
  "TRANSFUSED",
  "EXPIRED",
  "DISCARDED",
];

function frequencyMap(stat, categories) {
  if (!stat?.values || !stat?.frequencies) return null;
  const frequencies = new Map(
    stat.values.map((value, index) => [value, Number(stat.frequencies[index] ?? 0)]),
  );
  const missing = categories.filter((category) => !frequencies.has(category));
  const knownTotal = [...frequencies.values()].reduce((sum, value) => sum + value, 0);
  const distinct = Math.abs(Number(stat.distinct ?? 0));
  const remainder = Math.max(0, 1 - Number(stat.nullFraction ?? 0) - knownTotal);
  const inferredFrequency =
    missing.length > 0 && distinct > stat.values.length ? remainder / missing.length : 0;
  return new Map(categories.map((category) => [category, frequencies.get(category) ?? inferredFrequency]));
}

function valueEpoch(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function histogramCdf(histogram, cutoff) {
  if (!histogram?.length) return null;
  const cutoffEpoch = valueEpoch(cutoff);
  const first = valueEpoch(histogram[0]);
  const last = valueEpoch(histogram.at(-1));
  if (cutoffEpoch === null || first === null || last === null) return null;
  if (cutoffEpoch < first) return 0;
  if (cutoffEpoch >= last) return 1;
  const intervalCount = histogram.length - 1;
  for (let index = 0; index < intervalCount; index += 1) {
    const start = valueEpoch(histogram[index]);
    const end = valueEpoch(histogram[index + 1]);
    if (start === null || end === null || cutoffEpoch > end) continue;
    const fraction = end === start ? 0 : (cutoffEpoch - start) / (end - start);
    return (index + fraction) / intervalCount;
  }
  return 1;
}

function estimatedFrequencyThrough(stat, cutoff) {
  if (!stat?.values || !stat?.frequencies) return null;
  const cutoffEpoch = valueEpoch(cutoff);
  if (cutoffEpoch === null) return null;
  const mcvFrequency = stat.values.reduce((sum, value, index) => {
    const epoch = valueEpoch(value);
    return epoch !== null && epoch <= cutoffEpoch ? sum + Number(stat.frequencies[index] ?? 0) : sum;
  }, 0);
  const mcvTotal = stat.frequencies.reduce((sum, value) => sum + Number(value ?? 0), 0);
  const remainder = Math.max(0, 1 - Number(stat.nullFraction ?? 0) - mcvTotal);
  const histogramFraction = histogramCdf(stat.histogram, cutoff);
  return mcvFrequency + remainder * (histogramFraction ?? 0);
}

function estimatedRangeCount(stat, rowEstimate, lowerBound, upperBound) {
  const throughUpper = estimatedFrequencyThrough(stat, upperBound);
  const throughLower = estimatedFrequencyThrough(stat, lowerBound);
  if (throughUpper === null || throughLower === null) return null;
  return Math.max(0, Math.round(rowEstimate * (throughUpper - throughLower)));
}

function statByColumn(rows, relation, column) {
  return rows.find((row) => row.relation === relation && row.columnName === column);
}

async function estimateCityStats(cityCode) {
  const { hot, hist } = schemasFor(cityCode);
  const statsResult = await getPoolForCity(cityCode).query(
    `SELECT c.relname AS relation,
            GREATEST(c.reltuples, 0)::double precision AS "rowEstimate",
            s.attname AS "columnName",
            s.n_distinct AS distinct,
            s.null_frac AS "nullFraction",
            s.most_common_vals::text::text[] AS values,
            s.most_common_freqs::text::real[] AS frequencies,
            s.histogram_bounds::text::text[] AS histogram,
            CURRENT_DATE::text AS today,
            (CURRENT_DATE + 7)::text AS "expiryCutoff",
            (now() - interval '30 days')::text AS "activityCutoff",
            now()::text AS "now"
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stats s
         ON s.schemaname = n.nspname
        AND s.tablename = c.relname
        AND s.attname = ANY($3::text[])
      WHERE (n.nspname = $1 AND c.relname IN ('blood_units', 'reservations'))
         OR (n.nspname = $2 AND c.relname IN ('donations', 'transfusions'))`,
    [
      hot,
      hist,
      ["blood_group", "rh_factor", "component_type", "status", "urgency", "expiry_date", "collected_at", "transfused_at"],
    ],
  );
  const rows = statsResult.rows;
  const units = rows.find((row) => row.relation === "blood_units");
  if (!units) throw new Error(`Inventory estimates unavailable for ${cityCode}.`);

  const distribution = (relation, column, categories) =>
    frequencyMap(statByColumn(rows, relation, column), categories);
  const groups = distribution("blood_units", "blood_group", INVENTORY_GROUPS);
  const rhFactors = distribution("blood_units", "rh_factor", INVENTORY_RH_FACTORS);
  const components = distribution("blood_units", "component_type", INVENTORY_COMPONENTS);
  const statuses = distribution("blood_units", "status", INVENTORY_STATUSES);
  if (!groups || !rhFactors || !components || !statuses) {
    throw new Error(`Inventory planner statistics are incomplete for ${cityCode}.`);
  }

  const rowEstimate = Number(units.rowEstimate);
  const matrixRows = [];
  const statusRows = INVENTORY_STATUSES.map((status) => ({
    status,
    count: Math.round(rowEstimate * statuses.get(status)),
  }));
  for (const bloodGroup of INVENTORY_GROUPS) {
    for (const rhFactor of INVENTORY_RH_FACTORS) {
      for (const componentType of INVENTORY_COMPONENTS) {
        for (const status of INVENTORY_STATUSES) {
          matrixRows.push({
            bloodGroup,
            rhFactor,
            componentType,
            status,
            count: Math.round(
              rowEstimate *
                groups.get(bloodGroup) *
                rhFactors.get(rhFactor) *
                components.get(componentType) *
                statuses.get(status),
            ),
          });
        }
      }
    }
  }

  const reservationRelation = rows.find((row) => row.relation === "reservations");
  const reservationStatus = statByColumn(rows, "reservations", "status");
  const reservationUrgency = statByColumn(rows, "reservations", "urgency");
  const reservationStatuses = reservationStatus?.values ?? [];
  const reservationUrgencies = reservationUrgency?.values ?? [];
  const reservationStatusFrequencies = frequencyMap(reservationStatus, reservationStatuses);
  const reservationUrgencyFrequencies = frequencyMap(reservationUrgency, reservationUrgencies);
  const reservationRows = reservationRelation && reservationStatusFrequencies && reservationUrgencyFrequencies
    ? reservationStatuses.flatMap((status) =>
        reservationUrgencies.map((urgency) => ({
          status,
          urgency,
          count: Math.round(
            Number(reservationRelation.rowEstimate) *
              reservationStatusFrequencies.get(status) *
              reservationUrgencyFrequencies.get(urgency),
          ),
        })),
      )
    : [];

  const donationsRelation = rows.find((row) => row.relation === "donations");
  const transfusionsRelation = rows.find((row) => row.relation === "transfusions");
  const dateStats = statByColumn(rows, "blood_units", "expiry_date");
  const donationDateStats = statByColumn(rows, "donations", "collected_at");
  const transfusionDateStats = statByColumn(rows, "transfusions", "transfused_at");
  const expiryFraction = estimatedFrequencyThrough(dateStats, units.expiryCutoff);
  const expiredFraction = estimatedFrequencyThrough(dateStats, units.today);
  const eligibleStatusFrequency = ["AVAILABLE", "QUARANTINE", "RESERVED"]
    .reduce((sum, status) => sum + statuses.get(status), 0);

  return {
    cityCode,
    approximate: true,
    matrixRows,
    statusRows,
    unknownStatusRows: 0,
    reservationRows,
    donationsCount: donationsRelation
      ? estimatedRangeCount(
          donationDateStats,
          Number(donationsRelation.rowEstimate),
          units.activityCutoff,
          units.now,
        ) ?? 0
      : 0,
    transfusionsCount: transfusionsRelation
      ? estimatedRangeCount(
          transfusionDateStats,
          Number(transfusionsRelation.rowEstimate),
          units.activityCutoff,
          units.now,
        ) ?? 0
      : 0,
    inventoryDegraded: false,
    expiry: {
      expiring7d: Math.round(rowEstimate * eligibleStatusFrequency * (expiryFraction ?? 0)),
      expired: Math.round(rowEstimate * (expiredFraction ?? 0)),
      available: Math.round(rowEstimate * statuses.get("AVAILABLE")),
      reserved: Math.round(rowEstimate * statuses.get("RESERVED")),
      quarantine: Math.round(rowEstimate * statuses.get("QUARANTINE")),
    },
  };
}

async function estimateCityTimeseries(cityCode, days) {
  const { hist } = schemasFor(cityCode);
  const result = await getPoolForCity(cityCode).query(
    `SELECT GREATEST(c.reltuples, 0)::double precision AS "rowEstimate",
            s.n_distinct AS distinct,
            s.null_frac AS "nullFraction",
            s.most_common_vals::text::text[] AS values,
            s.most_common_freqs::text::real[] AS frequencies,
            s.histogram_bounds::text::text[] AS histogram
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stats s
         ON s.schemaname = n.nspname
        AND s.tablename = c.relname
        AND s.attname = 'collected_at'
      WHERE n.nspname = $1
        AND c.relname = 'donations'`,
    [hist],
  );
  const stats = result.rows[0];
  if (!stats || (!stats.values && !stats.histogram)) {
    throw new Error(`Donation planner statistics are unavailable for ${cityCode}.`);
  }

  const now = Date.now();
  const lowerBound = now - days * 86_400_000;
  const dailyCounts = new Map();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    dailyCounts.set(new Date(now - offset * 86_400_000).toISOString().slice(0, 10), 0);
  }
  const rowEstimate = Number(stats.rowEstimate);
  const nonNullFraction = 1 - Number(stats.nullFraction ?? 0);
  const addToDay = (epoch, count) => {
    const day = new Date(epoch).toISOString().slice(0, 10);
    if (dailyCounts.has(day)) dailyCounts.set(day, dailyCounts.get(day) + count);
  };

  const mcvFrequency = (stats.frequencies ?? []).reduce((sum, frequency) => sum + Number(frequency), 0);
  (stats.values ?? []).forEach((value, index) => {
    const epoch = valueEpoch(value);
    if (epoch !== null && epoch >= lowerBound && epoch <= now) {
      addToDay(epoch, rowEstimate * nonNullFraction * Number(stats.frequencies[index] ?? 0));
    }
  });

  const histogram = (stats.histogram ?? []).map(valueEpoch);
  if (histogram.length > 1) {
    const remainingFrequency = Math.max(0, 1 - mcvFrequency);
    const intervalFrequency = remainingFrequency / (histogram.length - 1);
    for (let index = 0; index < histogram.length - 1; index += 1) {
      const intervalStart = histogram[index];
      const intervalEnd = histogram[index + 1];
      if (intervalStart === null || intervalEnd === null || intervalEnd <= intervalStart) continue;
      const clippedStart = Math.max(intervalStart, lowerBound);
      const clippedEnd = Math.min(intervalEnd, now);
      if (clippedEnd <= clippedStart) continue;
      for (const day of dailyCounts.keys()) {
        const dayStart = Date.parse(`${day}T00:00:00.000Z`);
        const overlap = Math.max(0, Math.min(clippedEnd, dayStart + 86_400_000) - Math.max(clippedStart, dayStart));
        if (overlap > 0) {
          dailyCounts.set(
            day,
            dailyCounts.get(day) +
              rowEstimate * nonNullFraction * intervalFrequency * (overlap / (intervalEnd - intervalStart)),
          );
        }
      }
    }
  }

  return {
    approximate: true,
    rows: [...dailyCounts].map(([day, donations]) => ({ day, donations: Math.round(donations) })),
  };
}

async function computeCityStats(cityCode, bankId) {
  const { hot, hist } = schemasFor(cityCode);
  const bankFilter = bankId ? " WHERE blood_bank_id = $1" : "";
  const bankValues = bankId ? [bankId] : [];
  // One connection for all six aggregates, each statement bounded by the
  // shard timeout. node-postgres queues queries on a single client, so this
  // costs nothing in latency but stops one dashboard request from holding
  // every slot of a small city pool.
  return withCityStatsClient(cityCode, async (client) => {
    let inventoryDegraded = false;
    let matrix;
    let statusRows = null;
    let unknownStatusRows = 0;
    try {
      matrix = await client.query(
        `SELECT blood_group::text AS "bloodGroup", rh_factor::text AS "rhFactor",
                component_type::text AS "componentType", status::text AS status,
                count(*)::int AS count,
                count(*) FILTER (
                  WHERE expiry_date <= CURRENT_DATE + 7
                    AND status IN ('AVAILABLE', 'QUARANTINE', 'RESERVED')
                )::int AS "expiring7d",
                count(*) FILTER (WHERE expiry_date <= CURRENT_DATE)::int AS expired
           FROM ${hot}.blood_units
           ${bankFilter}
           GROUP BY blood_group, rh_factor, component_type, status`,
        bankValues,
      );
    } catch (error) {
      if (error.code !== "22P03") throw error;
      inventoryDegraded = true;
      log.warn({ cityCode, err: error.message }, "invalid inventory enum; using status-filtered aggregates");
      matrix = await client.query(
        `SELECT blood_group::text AS "bloodGroup", rh_factor::text AS "rhFactor",
                component_type::text AS "componentType", 'AVAILABLE'::text AS status,
                count(*)::int AS count
           FROM ${hot}.blood_units
           WHERE status = 'AVAILABLE'${bankId ? " AND blood_bank_id = $1" : ""}
           GROUP BY 1, 2, 3`,
        bankValues,
      );
      const statusCounts = await client.query(
        `SELECT count(*)::bigint AS total,
                count(*) FILTER (WHERE status = 'AVAILABLE')::int AS available,
                count(*) FILTER (WHERE status = 'RESERVED')::int AS reserved,
                count(*) FILTER (WHERE status = 'QUARANTINE')::int AS quarantine,
                count(*) FILTER (WHERE status = 'DISPATCHED')::int AS dispatched,
                count(*) FILTER (WHERE status = 'TRANSFUSED')::int AS transfused,
                count(*) FILTER (WHERE status = 'EXPIRED')::int AS expired,
                count(*) FILTER (WHERE status = 'DISCARDED')::int AS discarded,
                count(*) FILTER (
                  WHERE expiry_date <= CURRENT_DATE + 7
                    AND status IN ('AVAILABLE', 'QUARANTINE', 'RESERVED')
                )::int AS "expiring7d",
                count(*) FILTER (WHERE expiry_date <= CURRENT_DATE)::int AS "expiredByDate"
         FROM ${hot}.blood_units${bankFilter}`,
        bankValues,
      );
      const counts = statusCounts.rows[0];
      statusRows = Object.entries(counts)
        .filter(([status]) => !["total", "expiring7d", "expiredByDate"].includes(status))
        .map(([status, count]) => ({ status: status.toUpperCase(), count }));
      unknownStatusRows = Number(counts.total) - statusRows.reduce((sum, row) => sum + row.count, 0);
      matrix.expiry = {
        expiring7d: counts.expiring7d,
        expired: counts.expiredByDate,
      };
    }
    const reservations = bankId
      ? await client.query(
          `SELECT r.status::text AS status, r.urgency::text AS urgency, count(*)::int AS count
             FROM ${hot}.reservations r
             JOIN ${hot}.blood_units u ON u.unit_id = r.unit_id
             WHERE u.blood_bank_id = $1
             GROUP BY 1, 2`,
          bankValues,
        )
      : await client.query(
          `SELECT status::text AS status, urgency::text AS urgency, count(*)::int AS count
             FROM ${hot}.reservations
             GROUP BY 1, 2`,
        );
    const donations = await client.query(
      `SELECT count(*)::int AS count
         FROM ${hist}.donations
         WHERE collected_at >= now() - interval '30 days'${bankId ? " AND blood_bank_id = $1" : ""}`,
      bankValues,
    );
    // Joining 15k transfusions against 5M units makes PostgreSQL scan the whole
    // unit table and can take tens of seconds on a busy shard. For the
    // system-wide view there is nothing to filter, and for a bank we probe the
    // unit primary key instead of joining the full table.
    const transfusions = bankId
      ? await client.query(
          `SELECT count(*)::int AS count
             FROM ${hist}.transfusions t
             WHERE t.transfused_at >= now() - interval '30 days'
               AND EXISTS (
                 SELECT 1 FROM ${hot}.blood_units u
                 WHERE u.unit_id = t.unit_id AND u.blood_bank_id = $1
               )`,
          [bankId],
        )
      : await client.query(
          `SELECT count(*)::int AS count
             FROM ${hist}.transfusions
             WHERE transfused_at >= now() - interval '30 days'`,
        );
    // Expiry pressure is computed per shard in SQL so the dashboard never
    // pulls every row over the wire just to count the urgent ones.
    const expiry = matrix.expiry ?? {
      expiring7d: matrix.rows.reduce((sum, row) => sum + row.expiring7d, 0),
      expired: matrix.rows.reduce((sum, row) => sum + row.expired, 0),
    };
    return {
      cityCode,
      matrixRows: matrix.rows,
      statusRows,
      unknownStatusRows,
      reservationRows: reservations.rows,
      donationsCount: donations.rows[0]?.count ?? 0,
      transfusionsCount: transfusions.rows[0]?.count ?? 0,
      inventoryDegraded,
      expiry: {
        ...expiry,
        available: statusRows?.find((row) => row.status === "AVAILABLE")?.count
          ?? matrix.rows.reduce((sum, row) => sum + (row.status === "AVAILABLE" ? row.count : 0), 0),
        reserved: statusRows?.find((row) => row.status === "RESERVED")?.count
          ?? matrix.rows.reduce((sum, row) => sum + (row.status === "RESERVED" ? row.count : 0), 0),
        quarantine: statusRows?.find((row) => row.status === "QUARANTINE")?.count
          ?? matrix.rows.reduce((sum, row) => sum + (row.status === "QUARANTINE" ? row.count : 0), 0),
      },
    };
  });
}

async function refreshCityStats(cityCode, bankId) {
  const key = cityCacheKey(cityCode, bankId);
  const existing = cityInflight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const lockToken = randomUUID();
    const lockKey = `${key}:refresh-lock`;
    const usesSharedCache = cacheMode() === "redis";
    const ownsLock = usesSharedCache
      ? await cacheSetIfAbsent(lockKey, lockToken, STATS_REFRESH_LOCK_TTL_SECONDS)
      : false;
    const lockContended =
      usesSharedCache && !ownsLock ? Boolean(await cacheGet(lockKey)) : false;

    if (lockContended) {
      for (let attempt = 0; attempt < 220; attempt += 1) {
        await sleep(250);
        const raw = await cacheGet(key);
        if (raw) {
          try {
            const cached = JSON.parse(raw);
            if (Array.isArray(cached.matrixRows) && Array.isArray(cached.reservationRows)) {
              return cached;
            }
          } catch {
            // A partial cache write is ignored; the lock owner can repopulate it.
          }
        }
        if (attempt % 20 === 19) {
          const lockStillExists = await cacheGet(lockKey);
          if (!lockStillExists) break;
        }
      }
      throw new Error(`Timed out waiting for the shared stats refresh for ${cityCode}.`);
    }

    try {
      const payload = { ...(await computeCityStats(cityCode, bankId)), savedAt: Date.now() };
      await cacheSet(key, JSON.stringify(payload), STATS_CACHE_TTL_SECONDS);
      return payload;
    } finally {
      if (ownsLock) await cacheDeleteIfValue(lockKey, lockToken);
    }
  })();
  cityInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    cityInflight.delete(key);
  }
}

async function loadCityStats(cityCode, bankId) {
  const raw = await cacheGet(cityCacheKey(cityCode, bankId));
  let cached = null;
  if (raw) {
    try {
      cached = JSON.parse(raw);
    } catch {
      cached = null;
    }
  }
  if (cached?.savedAt && Array.isArray(cached.matrixRows) && Array.isArray(cached.reservationRows)) {
    if (Date.now() - cached.savedAt < STATS_FRESH_MS) return cached;
    if (bankId) {
      refreshCityStats(cityCode, bankId).catch((error) => {
        log.warn({ err: error.message, cityCode }, "stats background refresh failed; serving cached city");
      });
      return cached;
    }
  }
  if (!bankId) return estimateCityStats(cityCode);
  return refreshCityStats(cityCode, bankId);
}

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
    const [flags, systemCounts] = await Promise.all([
      getChaosFlags(),
      req.user.role === "SYSTEM_ADMIN"
        ? getCatalogPool().query(
            `SELECT
               (SELECT GREATEST(reltuples, 0)::bigint
                  FROM pg_class
                 WHERE oid = 'catalog.users'::regclass) AS "userCount",
               (SELECT count(*)::int FROM catalog.hospitals WHERE is_active) AS "hospitalCount",
               (SELECT count(*)::int FROM catalog.blood_banks WHERE is_active) AS "bloodBankCount"`,
          )
        : Promise.resolve(null),
    ]);

    // Scatter-gather: one round trip per city, isolated failure per city.
    // Cached cities answer without touching PostgreSQL; stale ones are served
    // immediately and refreshed in the background.
    const settled = await Promise.allSettled(
      cities.map((cityCode) => loadCityStats(cityCode, bankId)),
    );

    const unavailableCities = [];
    const totals = Object.create(null);
    const byCity = Object.create(null);
    const expiringByCity = Object.create(null);
    const degradedCities = [];
    const estimatedCities = [];
    const unknownStatusRowsByCity = Object.create(null);
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
      const { matrixRows, reservationRows, donationsCount, transfusionsCount, inventoryDegraded, expiry } = outcome.value;
      const { statusRows, unknownStatusRows } = outcome.value;
      if (outcome.value.approximate) estimatedCities.push(cityCode);
      if (inventoryDegraded) {
        degradedCities.push(cityCode);
        if (unknownStatusRows > 0) unknownStatusRowsByCity[cityCode] = unknownStatusRows;
      }
      const cityMatrix = Object.create(null);
      for (const row of matrixRows) {
        const key = `${row.bloodGroup}${row.rhFactor}`;
        if (!statusRows) totals[row.status] = (totals[row.status] ?? 0) + row.count;
        if (row.status === "AVAILABLE") {
          groupTotals[key] = (groupTotals[key] ?? 0) + row.count;
          if (!cityMatrix[row.componentType]) cityMatrix[row.componentType] = Object.create(null);
          if (!cityMatrix[row.componentType][key]) cityMatrix[row.componentType][key] = 0;
          cityMatrix[row.componentType][key] += row.count;
        }
      }
      for (const row of statusRows ?? []) {
        totals[row.status] = (totals[row.status] ?? 0) + row.count;
      }
      for (const row of reservationRows) {
        reservationsByStatus[row.status] = (reservationsByStatus[row.status] ?? 0) + row.count;
        reservationsByUrgency[row.urgency] = (reservationsByUrgency[row.urgency] ?? 0) + row.count;
      }
      donationsLast30Days += donationsCount;
      transfusionsLast30Days += transfusionsCount;
      if (expiry) expiringByCity[cityCode] = expiry;
      byCity[cityCode] = { matrix: cityMatrix };
    });

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
        ...(systemCounts ? systemCounts.rows[0] : {}),
      },
      unavailableCities,
      partial: unavailableCities.length > 0,
      degradedCities,
      unknownStatusRowsByCity,
      estimatedCities,
      catalogCountsApproximate: Boolean(systemCounts),
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
    const versions = isSharedCache() ? await inventoryVersions(cities) : null;
    const cacheKey = versions
      ? `stats:timeseries:v1:${createHash("sha256")
          .update(JSON.stringify({ cities, bankId, days }))
          .digest("base64url")}:${versionToken(versions, cities)}`
      : null;
    if (cacheKey) {
      const cached = await cacheGet(cacheKey);
      if (cached) {
        try {
          res.json(JSON.parse(cached));
          return;
        } catch {
          req.log?.warn({ cacheKey }, "ignoring invalid cached stats timeseries payload");
        }
      }
    }

    const settled = await Promise.allSettled(
      cities.map(async (cityCode) => {
        if (!bankId) return estimateCityTimeseries(cityCode, days);
        const { hist } = schemasFor(cityCode);
        const result = await withCityStatsClient(cityCode, (client) =>
          client.query(
            `SELECT date_trunc('day', collected_at)::date AS day,
                    count(*)::int AS donations
             FROM ${hist}.donations
             WHERE collected_at >= now() - ($1::int * interval '1 day')
               ${bankId ? "AND blood_bank_id = $2" : ""}
             GROUP BY 1
             ORDER BY 1`,
            bankId ? [days, bankId] : [days],
          ),
        );
        return { approximate: false, rows: result.rows };
      }),
    );

    const unavailableCities = [];
    const estimatedCities = [];
    const byDay = new Map();
    settled.forEach((outcome, index) => {
      if (outcome.status === "rejected") {
        unavailableCities.push(cities[index]);
        return;
      }
      if (outcome.value.approximate) estimatedCities.push(cities[index]);
      for (const row of outcome.value.rows) {
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

    const payload = {
      points,
      days,
      unavailableCities,
      estimatedCities,
      partial: unavailableCities.length > 0,
      generatedAt: new Date().toISOString(),
    };
    if (cacheKey && !payload.partial) {
      await cacheSet(cacheKey, JSON.stringify(payload), 60);
    }
    res.json(payload);
  }),
);

export default router;
