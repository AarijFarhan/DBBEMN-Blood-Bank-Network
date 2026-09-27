import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cacheMode,
  initCache,
  invalidateCityInventory,
  inventoryVersions,
  isSharedCache,
  versionToken,
} from "../src/cache/store.js";
import {
  addToFilter,
  candidateCities,
  describeSizing,
  mightContain,
  rebuildFilter,
} from "../src/cache/bloom.js";
import { isAccessTokenRevoked, revokeAccessToken } from "../src/cache/revocations.js";
import { buildKey, flagsSignature, recall, remember } from "../src/cache/searchCache.js";

// These run against the in-memory backend only: no database, no Redis. That is
// deliberate. The invariants worth pinning down here are the ones that make the
// cache safe rather than merely fast, and all of them are properties of the
// logic, not of the storage engine.
//
// The headline one is Bloom-filter soundness. A Bloom filter that ever reports
// "absent" for a record that exists turns a detail page into a 404 in a clinical
// system, so `mightContain` must never be false for an inserted id. Two separate
// real bugs were caught by exactly this assertion, which is why it is exhaustive
// rather than sampled: a bounded LRU evicting set bits, and an `every` written
// as `some`.

const CITIES = ["KHI", "LHE", "ISB"];
// Sizing is tuned for 50k items, so tests that want a meaningful filter must fill
// it close to that or the false-positive rate will be trivially good and prove
// nothing.
const FULL_LOAD = describeSizing().expectedItems;

test("cache falls back to the in-memory backend when no REDIS_URL is set", async () => {
  const mode = await initCache();
  assert.equal(mode, "memory");
  assert.equal(cacheMode(), "memory");
  assert.equal(isSharedCache(), false, "in-memory mode must not claim to be a shared cache");
});

test("an inventory bump changes only the city it belongs to", async () => {
  const before = await inventoryVersions(CITIES);
  assert.equal(versionToken(before, ["KHI", "LHE"]), "KHI0_LHE0");

  await invalidateCityInventory("LHE");
  const after = await inventoryVersions(CITIES);

  assert.notEqual(
    versionToken(before, ["KHI", "LHE"]),
    versionToken(after, ["KHI", "LHE"]),
    "a combined multi-city token must change when any contributing city changes",
  );
  assert.equal(
    versionToken(after, ["KHI"]),
    "KHI0",
    "an unrelated city must keep its version, or every write would flush the whole cache",
  );
});

test("cache keys are version-stamped, so a bump makes prior entries unreachable", async () => {
  const keyBefore = await buildKey("search", "fingerprint-abc", ["KHI", "LHE"]);
  await invalidateCityInventory("KHI");
  const keyAfter = await buildKey("search", "fingerprint-abc", ["KHI", "LHE"]);

  assert.notEqual(keyBefore, keyAfter);
  assert.equal(
    await recall(keyBefore, { cities: ["KHI", "LHE"], flags: {} }),
    null,
    "the stale key must not resolve after the bump",
  );
});

test("the same fingerprint in a different city set gets a different key", async () => {
  const one = await buildKey("search", "fp", ["KHI"]);
  const two = await buildKey("search", "fp", ["KHI", "LHE"]);
  assert.notEqual(one, two, "city set is part of the answer and must be part of the key");
});

test("cached payloads survive a round trip and expire on TTL", async () => {
  const key = await buildKey("search", "round-trip", ["KHI"]);
  const payload = { units: [{ unitId: "u-1" }], nextCursor: null, meta: { partial: false } };
  const flags = {};

  await remember(key, payload, { cities: ["KHI"], flags, complete: true, ttlSeconds: 30 });
  assert.deepEqual(await recall(key, { cities: ["KHI"], flags }), payload);

  await remember(key, payload, { cities: ["KHI"], flags, complete: true, ttlSeconds: 0.02 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(await recall(key, { cities: ["KHI"], flags }), null, "entry must expire");
});

test("an incomplete read is never cached, so a recovered shard cannot stay hidden", async () => {
  const key = await buildKey("search", "degraded", ["KHI"]);
  const flags = {};
  const partial = { units: [], meta: { partial: true, unavailableCities: ["LHE"] } };

  await remember(key, partial, { cities: ["KHI"], flags, complete: false, ttlSeconds: 30 });

  assert.equal(
    await recall(key, { cities: ["KHI"], flags }),
    null,
    "under-reporting stock must never be served from cache",
  );
});

test("a cached payload is discarded when the topology changes", async () => {
  const key = await buildKey("search", "topology", ["KHI", "LHE"]);
  const payload = { units: [{ unitId: "u-9" }] };
  await remember(key, payload, { cities: ["KHI", "LHE"], flags: {}, complete: true, ttlSeconds: 30 });

  // LHE's replica has now gone down, so an entry labelled as a replica read must
  // not be replayed as if the replica had answered.
  const changed = { KHI: {}, LHE: { replicaDown: true } };
  assert.equal(await recall(key, { cities: ["KHI", "LHE"], flags: changed }), null);
  assert.deepEqual(
    await recall(key, { cities: ["KHI", "LHE"], flags: {} }),
    payload,
    "the original entry is still valid while the topology is unchanged",
  );
});

test("flagsSignature reacts only to read-source state, not to lag", () => {
  const base = flagsSignature(["KHI", "LHE"], { KHI: {}, LHE: {} });
  assert.equal(
    flagsSignature(["KHI", "LHE"], { KHI: { extraLagMs: 900 }, LHE: {} }),
    base,
    "replica lag is telemetry; including it would discard hits every few seconds",
  );
  assert.notEqual(
    flagsSignature(["KHI", "LHE"], { KHI: {}, LHE: { replicaDown: true } }),
    base,
  );
  assert.notEqual(flagsSignature(["KHI", "LHE"], { KHI: { primaryDown: true }, LHE: {} }), base);
});

test("bloom filter reports no false negatives at full design capacity", async () => {
  const ids = Array.from({ length: FULL_LOAD }, (_, index) => `unit-${index}`);
  await rebuildFilter("unit", "KHI", ids);

  for (const id of ids) {
    assert.equal(
      await mightContain("unit", "KHI", id),
      true,
      `false negative for ${id}: the filter would make this lookup skip the shard that holds it`,
    );
  }
});

test("bloom filter false-positive rate stays near the configured target", async () => {
  const ids = Array.from({ length: FULL_LOAD }, (_, index) => `unit-${index}`);
  await rebuildFilter("unit", "LHE", ids);

  const trials = 20_000;
  let positives = 0;
  for (let index = 0; index < trials; index += 1) {
    if (await mightContain("unit", "LHE", `absent-${index}`)) positives += 1;
  }
  const rate = positives / trials;

  // Loose bound on purpose: the point is to catch an order-of-magnitude
  // regression (such as `some` instead of `every`, which yields ~24%), not to
  // pin the rate to a value that depends on hash distribution.
  assert.ok(
    rate <= 0.002,
    `false-positive rate ${(rate * 100).toFixed(3)}% is far above the ${describeSizing().errorRate * 100}% target`,
  );
});

test("a filter rebuilt from an empty table gives trustworthy negatives", async () => {
  await rebuildFilter("unit", "ISB", []);
  assert.equal(await mightContain("unit", "ISB", "unit-1"), false);
});

test("a shard whose filter was never built is never skipped", async () => {
  // Uses its own kind so the result does not depend on what an earlier test
  // happened to build. Shared state across tests here is a real hazard: a filter
  // rebuilt as empty in one test legitimately answers "no" in the next.
  await rebuildFilter("donor", "KHI", ["donor-1"]);
  await rebuildFilter("donor", "LHE", []);

  const candidates = await candidateCities("donor", CITIES, "donor-1");

  assert.ok(candidates.includes("KHI"), "the shard that holds the record must be kept");
  assert.ok(candidates.includes("ISB"), "an unbuilt filter must not narrow the search");
  assert.ok(!candidates.includes("LHE"), "a trusted empty filter should be skipped");
});

test("an insert that lands after a rebuild keeps the filter usable", async () => {
  await rebuildFilter("unit", "KHI", ["unit-1"]);
  await addToFilter("unit", "KHI", "unit-2");

  assert.equal(await mightContain("unit", "KHI", "unit-1"), true);
  assert.equal(
    await mightContain("unit", "KHI", "unit-2"),
    true,
    "a record inserted after the rebuild must still be found, or the filter would 404 it",
  );
});

test("revoking an access token makes it rejected until it expires", async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 900;

  assert.equal(await isAccessTokenRevoked("jti-a", expiresAt), false);
  assert.equal(await revokeAccessToken("jti-a", expiresAt), true);
  assert.equal(await isAccessTokenRevoked("jti-a", expiresAt), true);
  assert.equal(await isAccessTokenRevoked("jti-b", expiresAt), false, "other sessions are unaffected");
});

test("revoking a token that carries no jti or has expired is a no-op", async () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  assert.equal(await revokeAccessToken("jti-c", past), false);
  assert.equal(await revokeAccessToken(undefined, past + 900), false);
  // A token issued before revocation existed has no jti; the middleware treats it
  // as un-revocable rather than rejecting a valid session.
  assert.equal(await isAccessTokenRevoked(undefined, past + 900), false);
});
