/**
 * Rebuild the presence indexes from the authoritative tables.
 *
 * Run this after changing a loader, after a cache outage, or whenever a filter is
 * suspected of being stale. An untrusted filter is never consulted, so this
 * command can only restore performance — it cannot change any answer.
 *
 *   pnpm cache:rebuild
 *   pnpm cache:rebuild -- --city=KHI
 */
import { initCache, closeCache } from "../backend/src/cache/store.js";
import { CITY_CODES } from "../backend/src/db/shard-router.js";
import { PRESENCE_LOADERS, rebuildAllPresenceFilters } from "../backend/src/services/presence.js";
import { allCityPools, getCatalogPool, waitForDatabases } from "../backend/src/db/registry.js";
import { describeSizing } from "../backend/src/cache/bloom.js";

const requested = process.argv
  .find((arg) => arg.startsWith("--city="))
  ?.slice("--city=".length)
  ?.trim()
  ?.toUpperCase();

const cities = requested ? CITY_CODES.filter((code) => code === requested) : CITY_CODES;
if (requested && cities.length === 0) {
  process.stderr.write(`cache:rebuild: unknown city "${requested}". Known: ${CITY_CODES.join(", ")}\n`);
  process.exit(1);
}

const healthy = await waitForDatabases();
if (!healthy) {
  process.stderr.write("cache:rebuild: one or more databases are unreachable. Not rebuilding.\n");
  process.exit(1);
}

const mode = await initCache();
process.stdout.write(`cache:rebuild: backend=${mode} ${JSON.stringify(describeSizing())}\n`);
if (mode === "memory") {
  process.stdout.write(
    "  note: filters are process-local and will be lost on restart. Set REDIS_URL to keep them.\n",
  );
}

const results = await rebuildAllPresenceFilters(PRESENCE_LOADERS, cities);
for (const row of results) {
  const status = row.trusted ? `trusted, ${row.inserted} ids` : `FAILED: ${row.error}`;
  process.stdout.write(`  ${row.cityCode}/${row.kind}: ${status}\n`);
}

const failed = results.filter((row) => !row.trusted);
process.stdout.write(
  `cache:rebuild: ${results.length - failed.length}/${results.length} filters rebuilt\n`,
);
if (failed.length > 0) {
  process.stderr.write(
    "cache:rebuild: untrusted filters will scan every city until a rebuild succeeds.\n",
  );
}

await closeCache();
const closers = [getCatalogPool(), ...allCityPools().map((entry) => entry.pool)];
await Promise.allSettled([...new Set(closers)].map((pool) => pool.end()));

process.exit(failed.length > 0 ? 1 : 0);
