/**
 * Bloom filter used as a negative-lookup shortcut.
 *
 * A Bloom filter can answer "definitely not present" (no false negatives) and
 * "possibly present" (with a bounded false-positive rate). DBBEMN only ever uses
 * it to *skip* a shard that cannot hold the record, so a false positive costs
 * one wasted query and a false negative is impossible by construction. That
 * asymmetry is what makes it safe in front of a clinical lookup.
 *
 * The one thing that *can* produce a false negative is a filter that is out of
 * sync with the table it summarises. So this module is deliberately paranoid:
 *
 *  - a filter with no "trusted" marker is treated as unusable, and callers fall
 *    back to querying every shard exactly as they did before;
 *  - `markTrusted()` is only called by the rebuild routine, which derives the
 *    filter from the table itself;
 *  - every insert is best-effort. A failed insert is logged and the filter is
 *    marked untrusted rather than silently allowing a false negative later.
 *
 * Hashing uses Kirsch–Mitzenmacher double hashing: h_i(x) = (h1 + i*h2) mod m,
 * which needs two independent hashes instead of k and gives the same error rate.
 */
import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import { cacheKey, cacheGet, cacheSet, backendForBits } from "./store.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ module: "bloom" });

/**
 * Bits per item for a target false-positive rate: m = -n·ln(p) / (ln 2)².
 * Optimal hash count: k = (m/n)·ln 2.
 */
function sizing(expectedItems, errorRate) {
  const bits = Math.max(64, Math.ceil((-expectedItems * Math.log(errorRate)) / Math.LN2 ** 2));
  const hashes = Math.max(1, Math.min(16, Math.round((bits / expectedItems) * Math.LN2)));
  return { bits, hashes };
}

const SIZING = sizing(env.bloom.expectedItems, env.bloom.errorRate);

function hashPair(value) {
  const digest = createHash("sha256").update(value).digest();
  // Two 32-bit lanes from one digest: independent enough for double hashing,
  // and avoids a second pass over the input.
  const h1 = digest.readUInt32BE(0);
  const h2 = digest.readUInt32BE(4) | 1; // odd, so the sequence covers the space
  return [h1, h2];
}

function offsetsFor(value, { bits, hashes }) {
  const [h1, h2] = hashPair(value);
  const offsets = new Array(hashes);
  for (let i = 0; i < hashes; i += 1) {
    offsets[i] = (h1 + Math.imul(i, h2) >>> 0) % bits;
  }
  return offsets;
}

/** Filter key namespaced per city and record kind, e.g. `bloom:unit:KHI`. */
export function filterKey(kind, cityCode) {
  return `bloom:${kind}:${cityCode}`;
}

function trustedKey(kind, cityCode) {
  return `${filterKey(kind, cityCode)}:trusted`;
}

/**
 * Per-filter mutation counter.
 *
 * The trust marker alone cannot detect a *stale* filter: if a row commits while
 * the cache backend is unreachable, the insert never reaches the filter but the
 * marker still says "trusted", and a lookup would then wrongly skip the shard
 * that holds the new row.
 *
 * Every successful insert bumps this counter. The trust marker records the
 * counter value observed when the filter was built, so any insert the filter
 * missed is detectable. A mismatch invalidates trust, exactly like a failed
 * insert does.
 *
 * Residual gap: a process that dies between COMMIT and the insert leaves the
 * counter un-bumped. That window is one cache call wide, and the operational
 * remedy is to rebuild presence filters on deploy and after a cache outage —
 * which `rebuildPresenceFilters` is for.
 */
function epochKey(kind, cityCode) {
  return `${filterKey(kind, cityCode)}:epoch`;
}

async function readEpoch(kind, cityCode) {
  const raw = await cacheGet(epochKey(kind, cityCode));
  return Number(raw ?? 0);
}

async function bumpEpoch(kind, cityCode) {
  try {
    await backendForBits().incr(cacheKey(epochKey(kind, cityCode)));
  } catch (error) {
    log.warn({ err: error.message, kind, city: cityCode }, "failed to bump presence epoch");
  }
}

export function isEnabled() {
  return env.bloom.enabled;
}

export function describeSizing() {
  return {
    expectedItems: env.bloom.expectedItems,
    errorRate: env.bloom.errorRate,
    bits: SIZING.bits,
    hashes: SIZING.hashes,
    approximateBytes: Math.ceil(SIZING.bits / 8),
  };
}

/**
 * Record an id as present. Call this *after* the row is committed.
 *
 * If this fails the filter must not be trusted, because the row now exists in
 * the table but not in the filter, and a lookup would wrongly skip the shard.
 */
export async function addToFilter(kind, cityCode, id) {
  if (!env.bloom.enabled) return;
  try {
    const key = cacheKey(filterKey(kind, cityCode));
    for (const offset of offsetsFor(String(id), SIZING)) {
      await backendForBits().setBit(key, offset);
    }
    await bumpEpoch(kind, cityCode);
  } catch (error) {
    log.warn({ err: error.message, kind, city: cityCode }, "bloom insert failed; untrusting filter");
    await clearTrusted(kind, cityCode);
  }
}

export async function addManyToFilter(kind, cityCode, ids) {
  if (!env.bloom.enabled || ids.length === 0) return;
  try {
    const key = cacheKey(filterKey(kind, cityCode));
    const bits = backendForBits();
    for (const id of ids) {
      for (const offset of offsetsFor(String(id), SIZING)) {
        await bits.setBit(key, offset);
      }
    }
    await bumpEpoch(kind, cityCode);
  } catch (error) {
    log.warn({ err: error.message, kind, city: cityCode }, "bloom bulk insert failed; untrusting filter");
    await clearTrusted(kind, cityCode);
  }
}

/**
 * Whether the filter can be consulted at all. An untrusted filter answers
 * "maybe" for everything, which is always safe but never faster.
 *
 * Trust requires both the marker *and* a matching epoch snapshot: the marker
 * says "built from the table", the epoch says "still in sync with it".
 */
async function isTrusted(kind, cityCode) {
  const marker = await cacheGet(trustedKey(kind, cityCode));
  if (marker !== "1") return false;
  const builtAt = Number((await cacheGet(`${trustedKey(kind, cityCode)}:at`)) ?? 0);
  if (builtAt !== (await readEpoch(kind, cityCode))) {
    log.debug({ kind, city: cityCode }, "presence filter is stale; ignoring it");
    return false;
  }
  return true;
}

async function markTrusted(kind, cityCode) {
  // No TTL: trust is revoked explicitly by clearTrusted(), not by expiry.
  await cacheSet(trustedKey(kind, cityCode), "1", 0);
  // Snapshot the mutation counter this filter is now in sync with.
  await cacheSet(`${trustedKey(kind, cityCode)}:at`, String(await readEpoch(kind, cityCode)), 0);
}

async function clearTrusted(kind, cityCode) {
  await cacheSet(trustedKey(kind, cityCode), "0", 0);
}

/**
 * Can this id possibly live on this shard?
 *
 * Returns `true` when the answer is unknown (filter disabled, untrusted, or the
 * backend hiccupped). Callers must treat `false` as "skip this shard" and `true`
 * as "ask the database".
 */
export async function mightContain(kind, cityCode, id) {
  if (!env.bloom.enabled) return true;
  try {
    if (!(await isTrusted(kind, cityCode))) return true;
    const offsets = offsetsFor(String(id), SIZING);
    const bits = await backendForBits().getBits(cacheKey(filterKey(kind, cityCode)), offsets);
    // `every`, not `some`. Membership requires ALL k probe bits to be set. Using
    // `some` here would return true whenever a single bit happened to be set —
    // roughly `1 - e^(-k·fill)` of the time, i.e. ~24% instead of ~0.1%. It
    // would still have no false negatives, so it would pass a naive
    // correctness-only test while providing almost no filtering at all.
    return bits.every((bit) => bit === 1);
  } catch (error) {
    log.debug({ err: error.message, kind, city: cityCode }, "bloom lookup failed; assuming present");
    return true;
  }
}

/**
 * Filter cities down to those that could hold `id`, preserving the input order.
 * A result of `[]` is only possible when at least one trusted filter said no;
 * if every filter is untrusted the input comes back unchanged.
 */
export async function candidateCities(kind, cityCodes, id) {
  if (!env.bloom.enabled || !id) return cityCodes;
  const verdicts = await Promise.all(
    cityCodes.map((cityCode) => mightContain(kind, cityCode, id)),
  );
  return cityCodes.filter((_, index) => verdicts[index]);
}

/**
 * Rebuild a filter from the authoritative table and mark it trusted.
 * This is the only path that may set trust, which is what guarantees the
 * no-false-negative property.
 */
export async function rebuildFilter(kind, cityCode, ids) {
  if (!env.bloom.enabled) return { kind, cityCode, inserted: 0, trusted: false };
  await clearTrusted(kind, cityCode);
  await addManyToFilter(kind, cityCode, ids);
  await markTrusted(kind, cityCode);
  return { kind, cityCode, inserted: ids.length, trusted: true };
}

export { SIZING };
