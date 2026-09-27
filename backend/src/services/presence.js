/**
 * Cross-shard presence lookups.
 *
 * Several endpoints have to answer "which city holds this id?" by trying every
 * city in turn. That is linear in the shard count and runs on the hot path for
 * unit detail, reservation detail, and donor detail. The presence index narrows
 * the candidate set first, so a miss usually touches one shard instead of three.
 *
 * The contract that makes this safe:
 *
 *  - a filter may only be *trusted* after a rebuild from the authoritative table
 *    (see `cache/bloom.js`);
 *  - an untrusted or stale filter returns every city, so behaviour is identical
 *    to the pre-optimisation sequential scan;
 *  - a false positive costs one wasted query, never a wrong answer.
 *
 * In other words the optimisation can only make lookups faster. It cannot make a
 * lookup return "not found" for a record that exists.
 */
import { CITY_CODES, schemasFor } from "../db/shard-router.js";
import { getPoolForCity } from "../db/registry.js";
import { candidateCities, addToFilter, rebuildFilter } from "../cache/bloom.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ module: "presence" });

/** Entity kinds, kept as constants so a typo cannot silently create a new index. */
export const KIND = Object.freeze({
  UNIT: "unit",
  RESERVATION: "reservation",
  DONOR: "donor",
  DONATION: "donation",
});

/**
 * Find the first city whose lookup returns a row.
 *
 * `lookup` receives a city code and must return a truthy value or null/0 rows.
 * Ordering is preserved, so an early hit still wins over a later one.
 */
export async function locateAcrossCities(kind, id, cities, lookup) {
  const order = cities?.length ? cities : CITY_CODES;
  const candidates = await candidateCities(kind, order, id);
  const skipped = order.length - candidates.length;
  if (skipped > 0) {
    log.debug({ kind, id, skipped }, "presence filter skipped shards");
  }
  for (const cityCode of candidates) {
    const found = await lookup(cityCode);
    if (found) return found;
  }
  return null;
}

/**
 * Same, but collects every match instead of stopping at the first. Used where a
 * caller legitimately expects a row in more than one city.
 */
export async function collectAcrossCities(kind, id, cities, lookup) {
  const order = cities?.length ? cities : CITY_CODES;
  const candidates = await candidateCities(kind, order, id);
  const matches = [];
  for (const cityCode of candidates) {
    const found = await lookup(cityCode);
    if (found) matches.push(...(Array.isArray(found) ? found : [found]));
  }
  return matches;
}

/**
 * Record a newly created row in the presence index.
 *
 * Must be called *after* the row is committed. If it throws, the filter has
 * already marked itself untrusted internally, so the next lookup falls back to a
 * full scan rather than skipping this city.
 */
export async function rememberCreated(kind, cityCode, id) {
  await addToFilter(kind, cityCode, id);
}

/**
 * Rebuild one city's index for one kind from the table itself.
 *
 * This is the only operation permitted to grant trust, which is what makes the
 * no-false-negative property hold.
 */
export async function rebuildPresenceFilter(kind, cityCode, selectIds) {
  const ids = await selectIds();
  const outcome = await rebuildFilter(kind, cityCode, ids);
  log.info(outcome, "presence filter rebuilt");
  return outcome;
}

/**
 * Rebuild every kind for every city. Intended for boot, deploy, and ops.
 *
 * Failures are isolated per filter. A loader that references a table that does
 * not exist must not prevent the remaining filters from being built — otherwise
 * one typo silently disables the whole optimisation — and an unbuilt filter is
 * safe anyway, since it simply is not consulted.
 */
export async function rebuildAllPresenceFilters(loaders, cities = CITY_CODES) {
  const results = [];
  for (const cityCode of cities) {
    const schemas = schemasFor(cityCode);
    for (const kind of Object.values(KIND)) {
      const loader = loaders[kind];
      if (!loader) continue;
      try {
        const outcome = await rebuildPresenceFilter(kind, cityCode, async () => {
          const result = await getPoolForCity(cityCode).query(loader(schemas));
          return result.rows.map((row) => row.id);
        });
        results.push({ cityCode, ...outcome });
      } catch (error) {
        log.error({ err: error.message, kind, city: cityCode }, "presence filter rebuild failed; this lookup will scan every city");
        results.push({ cityCode, kind, trusted: false, error: error.message });
      }
    }
  }
  return results;
}

/**
 * Default id loaders, one SQL projection per table.
 *
 * They take the full schema map rather than just the hot schema because the
 * tables are not all in it: donors and donations are history data, while
 * reservations and units are hot. Getting that wrong fails at boot, so the
 * mapping lives in exactly one place and a rebuild and an insert can never
 * disagree about which table an id lives in.
 */
export const PRESENCE_LOADERS = Object.freeze({
  [KIND.UNIT]: ({ hot }) => `SELECT unit_id AS id FROM ${hot}.blood_units`,
  [KIND.RESERVATION]: ({ hot }) => `SELECT reservation_id AS id FROM ${hot}.reservations`,
  [KIND.DONOR]: ({ hist }) => `SELECT donor_id AS id FROM ${hist}.donors`,
  [KIND.DONATION]: ({ hist }) => `SELECT donation_id AS id FROM ${hist}.donations`,
});
