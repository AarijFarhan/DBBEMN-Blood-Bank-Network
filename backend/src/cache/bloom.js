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
 * Per-filter mutation counters.
 *
 * The trust marker alone cannot detect a *stale* filter: if a row commits while
 * the cache backend is unreachable, the insert never reaches the filter but the
 * marker still says "trusted", and a lookup would then wrongly skip the shard
 * that holds the new row.
 *
 * Three counters, and the difference between them is the whole point:
 *
 *  - `writes` counts write *intents*. It is bumped **before** the row is
 *    committed, so the filter stops being trusted at the moment the write
 *    starts - not after it finishes. A process that dies between the commit and
 *    the filter update therefore leaves the filter visibly behind.
 *  - `absorbed` counts writes the filter has caught up with. It is raised only
 *    after the bits are actually in place.
 *  - `pending` counts writes that are in flight right now: intent recorded, bits
 *    not yet written.
 *
 * The filter is trusted while `absorbed === writes && pending === 0`. Both
 * halves matter:
 *
 *  - `absorbed === writes` says every write that ever happened has been
 *    indexed. Because absorbed counts *completions* rather than a watermark,
 *    a writer that finishes late cannot make the filter claim to have absorbed
 *    a write whose bits are not in it yet - the thing that would turn a
 *    concurrent write into a false negative.
 *  - `pending === 0` says nobody is mid-write, so the filter is not being read
 *    while it is half updated.
 *
 * A write the filter absorbed keeps it trusted, so a busy city does not
 * silently lose its filter after the first insert. A write the filter missed
 * leaves the counts apart, which retires the filter and sends lookups back to
 * a full scan.
 *
 * The earlier design bumped a single counter after every successful insert and
 * compared it with a snapshot taken at build time. That made the filter
 * untrusted after the first write of any kind - so in a live system the filter
 * was never consulted - while still failing to catch the crash it was meant to
 * catch, because the bump came after the insert rather than before the commit.
 */
function writesKey(kind, cityCode) {
  return `${filterKey(kind, cityCode)}:writes`;
}

function absorbedKey(kind, cityCode) {
  return `${filterKey(kind, cityCode)}:absorbed`;
}

function pendingKey(kind, cityCode) {
  return `${filterKey(kind, cityCode)}:pending`;
}

async function readCounter(key) {
  const raw = await cacheGet(key);
  const value = Number(raw ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export async function readWrites(kind, cityCode) {
  return readCounter(writesKey(kind, cityCode));
}

export async function readAbsorbed(kind, cityCode) {
  return readCounter(absorbedKey(kind, cityCode));
}

export async function readPending(kind, cityCode) {
  return readCounter(pendingKey(kind, cityCode));
}

async function readCounters(kind, cityCode) {
  const [writes, absorbed, pending] = await Promise.all([
    readWrites(kind, cityCode),
    readAbsorbed(kind, cityCode),
    readPending(kind, cityCode),
  ]);
  return { writes, absorbed, pending };
}

/**
 * Record a write intent.
 *
 * Called before the row is committed, so that the filter stops being trusted
 * before the row becomes visible, and a crash between the commit and the
 * filter insert is visible as `absorbed !== writes`.
 */
export async function noteWrite(kind, cityCode) {
  if (!env.bloom.enabled) return 0;
  try {
    const bits = backendForBits();
    const observed = Number((await bits.incrBy(cacheKey(writesKey(kind, cityCode)), 1)) ?? 0);
    await bits.incrBy(cacheKey(pendingKey(kind, cityCode)), 1);
    return observed;
  } catch (error) {
    log.warn({ err: error.message, kind, city: cityCode }, "failed to record presence write");
    return 0;
  }
}

/**
 * Settle a write intent.
 *
 * Called once the write is done and the bits are in place, and also when the
 * write was rolled back: a row that was never committed needs no bit, so the
 * intent is simply resolved.
 */
export async function resolveWrite(kind, cityCode) {
  if (!env.bloom.enabled) return;
  try {
    const bits = backendForBits();
    await bits.incrBy(cacheKey(absorbedKey(kind, cityCode)), 1);
    // Clamp at zero: a counter that went negative would keep the filter
    // untrusted forever, and an untrusted filter is a slow one, not a wrong
    // one - but it is still a filter nobody consults.
    const remaining = Number((await bits.incrBy(cacheKey(pendingKey(kind, cityCode)), -1)) ?? 0);
    if (remaining < 0) await bits.set(cacheKey(pendingKey(kind, cityCode)), "0", 0);
  } catch (error) {
    log.warn({ err: error.message, kind, city: cityCode }, "failed to record absorbed presence writes");
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
 * Record one or more ids as present.
 *
 * Call this *after* the row is committed, and pair it with `resolveWrite` so
 * the filter knows the write has been absorbed. The write intent must have
 * been recorded with `noteWrite` before the commit.
 *
 * If this fails the filter must not be trusted, because the row now exists in
 * the table but not in the filter, and a lookup would wrongly skip the shard.
 */
export async function addToFilter(kind, cityCode, ids) {
  if (!env.bloom.enabled) return;
  const list = Array.isArray(ids) ? ids : [ids];
  if (list.length === 0) return;
  try {
    const key = cacheKey(filterKey(kind, cityCode));
    const offsets = [];
    for (const id of list) {
      offsets.push(...offsetsFor(String(id), SIZING));
    }
    await backendForBits().setBits(key, offsets);
  } catch (error) {
    log.warn({ err: error.message, kind, city: cityCode }, "bloom insert failed; untrusting filter");
    await clearTrusted(kind, cityCode);
  }
}

/**
 * Rebuild a filter from the authoritative table and mark it trusted.
 *
 * This is the only path that may set trust, which is what guarantees the
 * no-false-negative property.
 *
 * `idsOrLoader` is either the ids themselves or a function that reads the
 * table. Passing the loader matters: the table read happens *inside* the
 * window in which the counters are compared, so a write that commits while
 * the rebuild is running is seen as a write that overlapped, and the rebuild
 * degrades to "add bits only" instead of replacing the filter.
 */
export async function rebuildFilter(kind, cityCode, idsOrLoader) {
  if (!env.bloom.enabled) return { kind, cityCode, inserted: 0, trusted: false };
  const loader = typeof idsOrLoader === "function" ? idsOrLoader : async () => idsOrLoader;
  const before = await readCounters(kind, cityCode);
  const ids = await loader();
  const after = await readCounters(kind, cityCode);
  // Quiet means: no write started, no write finished, and nobody is mid-write.
  // Only then is it safe to replace the filter wholesale.
  const quiet =
    before.writes === after.writes &&
    before.absorbed === after.absorbed &&
    before.pending === 0 &&
    after.pending === 0;

  try {
    const key = cacheKey(filterKey(kind, cityCode));
    const bits = backendForBits();
    const offsets = [];
    for (const id of ids) {
      offsets.push(...offsetsFor(String(id), SIZING));
    }
    if (quiet) {
      // Safe to replace: nothing was written while the table was read, so the
      // table is the whole truth. A bulk replace is also one round trip, where
      // setting the bits one at a time was one round trip per bit.
      await bits.replaceBits(key, offsets);
      // Settle the counters. A write that was recorded but never completed - a
      // process that died between the commit and the filter update - is settled
      // here, because the table read is the authority on whether that row
      // exists.
      await cacheSet(absorbedKey(kind, cityCode), String(after.writes), 0);
      await cacheSet(pendingKey(kind, cityCode), "0", 0);
    } else {
      // A write overlapped the rebuild. Only ever *add* bits: replacing would
      // erase a row that another writer has already committed and indexed.
      // The counters are left alone, so the filter stays untrusted until that
      // write lands.
      await bits.setBits(key, offsets);
    }
    await markTrusted(kind, cityCode);
    return { kind, cityCode, inserted: ids.length, trusted: true };
  } catch (error) {
    log.warn({ err: error.message, kind, city: cityCode }, "bloom rebuild failed; untrusting filter");
    await clearTrusted(kind, cityCode);
    return { kind, cityCode, inserted: 0, trusted: false };
  }
}

/**
 * Whether the filter can be consulted at all. An untrusted filter answers
 * "maybe" for everything, which is always safe but never faster.
 *
 * Trust requires both the marker *and* a caught-up mutation count: the marker
 * says "built from the table", and the counters say "still in sync with it".
 */
async function isTrusted(kind, cityCode) {
  const marker = await cacheGet(trustedKey(kind, cityCode));
  if (marker !== "1") return false;
  const { absorbed, writes, pending } = await readCounters(kind, cityCode);
  if (absorbed !== writes || pending !== 0) {
    log.debug(
      { kind, city: cityCode, absorbed, writes, pending },
      "presence filter is stale; ignoring it",
    );
    return false;
  }
  return true;
}

async function markTrusted(kind, cityCode) {
  // No TTL: trust is revoked explicitly by clearTrusted(), not by expiry.
  await cacheSet(trustedKey(kind, cityCode), "1", 0);
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

export { SIZING };
