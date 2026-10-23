import { createRequire } from "node:module";
import { allCityPools, getCatalogPool, getPoolForCity } from "../backend/src/db/registry.js";
import { CITY_CODES, schemasFor } from "../backend/src/db/shard-router.js";

const require = createRequire(new URL("../backend/src/routes/catalog.js", import.meta.url));
const bcrypt = require("bcryptjs");
const batchSize = 5000;
const password = process.env.DONOR_DEFAULT_PASSWORD;
const apply = process.argv.includes("--apply");
const verifyOnly = process.argv.includes("--verify");

if (apply && verifyOnly) {
  throw new Error("Choose either --apply or --verify, not both.");
}
if (apply && !password) {
  throw new Error("Set DONOR_DEFAULT_PASSWORD before applying donor account provisioning.");
}
if (password && (password.length < 8 || Buffer.byteLength(password, "utf8") > 72)) {
  throw new Error("DONOR_DEFAULT_PASSWORD must be between 8 and 72 UTF-8 bytes.");
}

const catalog = getCatalogPool();

try {
  const profilesByCity = {};
  for (const cityCode of CITY_CODES) {
    const { hist } = schemasFor(cityCode);
    const result = await getPoolForCity(cityCode).query(
      `SELECT count(*)::bigint AS total FROM ${hist}.donors`,
    );
    profilesByCity[cityCode] = Number(result.rows[0].total);
  }

  const existing = await catalog.query(
    `SELECT donor_city_code::text AS city, count(*)::bigint AS total
     FROM catalog.users
     WHERE role = 'DONOR'
     GROUP BY donor_city_code`,
  );
  const existingByCity = Object.fromEntries(
    existing.rows.map((row) => [row.city.trim(), Number(row.total)]),
  );
  const plan = CITY_CODES.map((cityCode) => ({
    city: cityCode,
    profiles: profilesByCity[cityCode],
    linkedAccounts: existingByCity[cityCode] ?? 0,
    toCreate: Math.max(0, profilesByCity[cityCode] - (existingByCity[cityCode] ?? 0)),
  }));

  if (CITY_CODES.some((cityCode) => (existingByCity[cityCode] ?? 0) > profilesByCity[cityCode])) {
    console.warn("Some cities have more donor accounts than profiles; extra accounts will not be deleted.");
  }
  console.log(JSON.stringify({ mode: verifyOnly ? "verify" : apply ? "apply" : "dry-run", plan }, null, 2));
  if (verifyOnly) {
    const coverage = [];
    for (const cityCode of CITY_CODES) {
      const { hist } = schemasFor(cityCode);
      const shard = getPoolForCity(cityCode);
      let lastId = null;
      let linkedProfiles = 0;
      while (true) {
        const profiles = await shard.query(
          `SELECT donor_id::text AS donor_id
           FROM ${hist}.donors
           WHERE ($1::uuid IS NULL OR donor_id > $1::uuid)
           ORDER BY donor_id
           LIMIT $2`,
          [lastId, batchSize],
        );
        if (profiles.rowCount === 0) break;
        lastId = profiles.rows[profiles.rows.length - 1].donor_id;
        const linked = await catalog.query(
          `SELECT donor_id
           FROM catalog.users
           WHERE role = 'DONOR'
             AND donor_city_code = $1::char(3)
             AND donor_id = ANY($2::uuid[])`,
          [cityCode, profiles.rows.map((profile) => profile.donor_id)],
        );
        linkedProfiles += linked.rowCount;
      }
      const donorAccounts = existingByCity[cityCode] ?? 0;
      coverage.push({
        city: cityCode,
        profiles: profilesByCity[cityCode],
        linkedProfiles,
        missingProfiles: profilesByCity[cityCode] - linkedProfiles,
        donorAccounts,
        unmatchedAccounts: donorAccounts - linkedProfiles,
      });
    }
    console.log(JSON.stringify({ coverage }, null, 2));
    if (coverage.some((city) => city.missingProfiles > 0)) {
      throw new Error("Verification failed: one or more donor profiles have no linked login account.");
    }
  } else if (!apply) {
    console.log("Dry run only. Set DONOR_DEFAULT_PASSWORD and pass --apply to create accounts.");
  } else {
    await catalog.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_users_donor_profile
       ON catalog.users (donor_city_code, donor_id)
       WHERE role = 'DONOR'`,
    );
    const passwordHash = await bcrypt.hash(password, 12);
    const insertedByCity = {};

    for (const cityCode of CITY_CODES) {
      const { hist } = schemasFor(cityCode);
      const shard = getPoolForCity(cityCode);
      let lastId = null;
      let inserted = 0;
      let batches = 0;

      while (true) {
        const profiles = await shard.query(
          `SELECT donor_id::text AS donor_id
           FROM ${hist}.donors
           WHERE ($1::uuid IS NULL OR donor_id > $1::uuid)
           ORDER BY donor_id
           LIMIT $2`,
          [lastId, batchSize],
        );
        if (profiles.rowCount === 0) break;

        lastId = profiles.rows[profiles.rows.length - 1].donor_id;
        const result = await catalog.query(
          `INSERT INTO catalog.users
             (username, email, password_hash, role, donor_id, donor_city_code)
           SELECT 'donor-' || lower($2) || '-' || profile.donor_id::text,
                  'donor-' || lower($2) || '-' || profile.donor_id::text || '@donors.example.test',
                  $3, 'DONOR', profile.donor_id, $2::char(3)
           FROM jsonb_to_recordset($1::jsonb) AS profile(donor_id uuid)
           ON CONFLICT DO NOTHING`,
          [JSON.stringify(profiles.rows), cityCode, passwordHash],
        );
        inserted += result.rowCount;
        batches += 1;
        if (batches % 50 === 0) {
          console.log(`[provision] ${cityCode}: processed ${batches * batchSize}, created ${inserted}`);
        }
      }

      insertedByCity[cityCode] = inserted;
      console.log(`[provision] ${cityCode}: created ${inserted} accounts`);
    }

    const finalCounts = await catalog.query(
      `SELECT donor_city_code::text AS city, count(*)::bigint AS total
       FROM catalog.users
       WHERE role = 'DONOR'
       GROUP BY donor_city_code`,
    );
    const finalByCity = Object.fromEntries(
      finalCounts.rows.map((row) => [row.city.trim(), Number(row.total)]),
    );
    const coverage = [];
    for (const cityCode of CITY_CODES) {
      const { hist } = schemasFor(cityCode);
      const shard = getPoolForCity(cityCode);
      let lastId = null;
      let linkedProfiles = 0;
      while (true) {
        const profiles = await shard.query(
          `SELECT donor_id::text AS donor_id
           FROM ${hist}.donors
           WHERE ($1::uuid IS NULL OR donor_id > $1::uuid)
           ORDER BY donor_id
           LIMIT $2`,
          [lastId, batchSize],
        );
        if (profiles.rowCount === 0) break;
        lastId = profiles.rows[profiles.rows.length - 1].donor_id;
        const linked = await catalog.query(
          `SELECT donor_id
           FROM catalog.users
           WHERE role = 'DONOR'
             AND donor_city_code = $1::char(3)
             AND donor_id = ANY($2::uuid[])`,
          [cityCode, profiles.rows.map((profile) => profile.donor_id)],
        );
        linkedProfiles += linked.rowCount;
      }
      const donorAccounts = finalByCity[cityCode] ?? 0;
      coverage.push({
        city: cityCode,
        profiles: profilesByCity[cityCode],
        linkedProfiles,
        missingProfiles: profilesByCity[cityCode] - linkedProfiles,
        donorAccounts,
        unmatchedAccounts: donorAccounts - linkedProfiles,
        created: insertedByCity[cityCode],
      });
    }
    console.log(JSON.stringify({ coverage }, null, 2));

    if (coverage.some((city) => city.missingProfiles > 0)) {
      throw new Error("Verification failed: one or more donor profiles have no linked login account.");
    }
  }
} finally {
  const pools = [catalog, ...allCityPools().map(({ pool }) => pool)];
  await Promise.all([...new Set(pools)].map((pool) => pool.end()));
}
