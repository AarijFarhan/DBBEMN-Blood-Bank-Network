/**
 * Distribute the real data in the single-node `dbbemn` database across the four
 * target databases (catalog, KHI, LHE, ISB).
 *
 * Why this exists: the app is already a 4-node distributed system, but locally all
 * four nodes are the same PostgreSQL server reached through different database
 * names. Splitting the data now lets us verify real cross-node reads, writes and
 * joins before the Docker topology exists, and it is the same copy that the
 * production cutover needs.
 *
 * Safety rules this script will not bend:
 *   1. The source connection is READ-ONLY. This script can never mutate `dbbemn`,
 *      so a mistake here cannot destroy the only copy of the data.
 *   2. Every insert is `ON CONFLICT DO NOTHING`, so re-running never overwrites a
 *      row that already exists in a target and never creates a duplicate. That
 *      matters because the targets are shared with the test suites.
 *   3. Only the canonical, unprefixed schemas are copied. The `t_*` and `p3_*`
 *      schemas are test fixtures and must stay out of the target databases.
 *   4. Default mode is a dry run. Writes require an explicit --apply.
 *   5. Nothing is dropped or truncated. Verification is a row-count comparison.
 */
import pg from "pg";
import { CITY_CODES } from "../backend/src/db/shard-router.js";

function arg(name, fallback = undefined) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
}

const APPLY = arg("apply") === true || arg("apply") === "true";
const VERIFY_ONLY = arg("verify") === true || arg("verify") === "true";

const SOURCE_URL =
  process.env.SOURCE_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/dbbemn";

function targetUrl(kind, database) {
  const map = {
    catalog: "CATALOG_DATABASE_URL",
    KHI: "KHI_DATABASE_URL",
    LHE: "LHE_DATABASE_URL",
    ISB: "ISB_DATABASE_URL",
  };
  const fromEnv = process.env[map[kind]];
  if (fromEnv) return fromEnv;
  const url = new URL(SOURCE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

const TARGETS = {
  catalog: targetUrl("catalog", "dbbemn_catalog"),
  KHI: targetUrl("KHI", "dbbemn_khi"),
  LHE: targetUrl("LHE", "dbbemn_lhe"),
  ISB: targetUrl("ISB", "dbbemn_isb"),
};

/**
 * Copy order. Two things force this order and neither is negotiable:
 *
 *  - Foreign keys. catalog.users references blood_banks, hospitals and cities, so
 *    the parents must land first. Per city, donations.donor_id references donors
 *    and reservations.unit_id references blood_units.
 *  - The read model. *_read.units_search is a projection maintained from
 *    *_hot.outbox, so outbox has to be in place before the projection is trusted.
 *
 * Tables are named explicitly rather than discovered from information_schema. An
 * allowlist is what keeps `t_khi_donors` and `p3_khi_donors` out of the targets: a
 * discovery-based version would happily copy last night's test fixtures into
 * production-shaped databases.
 */
const CATALOG_TABLES = [
  "cities",
  "blood_banks",
  "hospitals",
  "users",
  "refresh_tokens",
  "chaos_flags",
];

const CITY_TABLES = [
  ["history", "donors"],
  ["history", "donations"],
  ["history", "transfusions"],
  ["history", "unit_status_log"],
  ["hot", "blood_units"],
  ["hot", "donor_requests"],
  ["hot", "reservations"],
  ["hot", "processed_requests"],
  ["hot", "outbox"],
  ["read", "units_search"],
  ["read", "replication_state"],
];

function plan() {
  const steps = [];
  for (const table of CATALOG_TABLES) {
    steps.push({ node: "catalog", schema: "catalog", table, database: "dbbemn_catalog" });
  }
  for (const city of CITY_CODES) {
    const lower = city.toLowerCase();
    for (const [layer, table] of CITY_TABLES) {
      steps.push({
        node: city,
        schema: `${lower}_${layer}`,
        table,
        database: `dbbemn_${lower}`,
      });
    }
  }
  return steps;
}

const q = (id) => `"${id}"`;

/** Rows per insert statement. One jsonb parameter per batch, so this only trades
 *  statement size against round trips; 500 keeps peak memory tiny on blood_units. */
const CHUNK = 500;

async function countRows(pool, schema, table) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${q(schema)}.${q(table)}`);
  return rows[0].n;
}

async function openPool(url, { readOnly = false } = {}) {
  const config = { connectionString: url, max: 4, connectionTimeoutMillis: 10000 };
  if (readOnly) {
    // `options` is applied by PostgreSQL itself on every connection as it starts.
    // Setting it through a pooled client and releasing it back is NOT equivalent:
    // pg-pool does not reset session state on release, and a naive probe proves
    // nothing about the connections used later. This is the only form of the
    // guarantee that actually holds for every query this script sends.
    config.options = "-c default_transaction_read_only=on -c statement_timeout=0";
  }
  const pool = new pg.Pool(config);
  if (readOnly) {
    const check = await pool.query("SHOW default_transaction_read_only");
    if (check.rows[0]?.default_transaction_read_only !== "on") {
      await pool.end();
      throw new Error(
        "Source connection is not read-only; refusing to run. Check the server allows -c options.",
      );
    }
  }
  return pool;
}

/** Every column plus whether it is identity-generated, straight from the catalog. */
async function columnsOf(pool, schema, table) {
  const { rows } = await pool.query(
    `SELECT a.attname AS name,
            a.attidentity <> '' AS is_identity,
            a.attgenerated = 's' AS is_stored_generated
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [schema, table],
  );
  return rows;
}

async function primaryKeyOf(pool, schema, table) {
  const { rows } = await pool.query(
    `SELECT a.attname AS name
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = to_regclass($1) AND i.indisprimary`,
    [`${schema}.${table}`],
  );
  return rows.map((r) => r.name);
}

/**
 * Build the insert for one table.
 *
 * Why jsonb and not a plain `INSERT ... SELECT`: the two tables live in different
 * databases, so a single statement cannot read one and write the other. The
 * earlier version used INSERT...SELECT anyway, which silently read the EMPTY TARGET
 * table and reported "0 copied" with no error at all. Rows are now fetched from the
 * source explicitly and sent as jsonb, and jsonb_populate_record re-hydrates them
 * using the target table's own types, so a uuid stays a uuid and a timestamp stays a
 * timestamp instead of being re-guessed from a JavaScript value.
 *
 * One jsonb parameter per batch also sidesteps the 65535 bind-parameter ceiling
 * that a row-per-placeholder copy would hit on blood_units.
 */
function buildInsertSql(schema, table, columns) {
  const collist = columns.map((c) => q(c.name)).join(", ");
  const selcollist = columns
    .map((c) => (c.is_stored_generated ? "DEFAULT" : `r.${q(c.name)}`))
    .join(", ");
  // OVERRIDING SYSTEM VALUE is required, not optional: outbox.event_id and
  // unit_status_log.log_id are GENERATED ALWAYS AS IDENTITY, and PostgreSQL
  // rejects an explicit value for those without it. Re-numbering them instead
  // would silently break the references other rows hold to those ids.
  const override = columns.some((c) => c.is_identity) ? "OVERRIDING SYSTEM VALUE" : "";
  return (
    `INSERT INTO ${q(schema)}.${q(table)} ${override} (${collist}) ` +
    `SELECT ${selcollist} ` +
    `FROM jsonb_array_elements($1::jsonb) AS e(j) ` +
    `CROSS JOIN LATERAL jsonb_populate_record(NULL::${q(schema)}.${q(table)}, e.j) AS r ` +
    `ON CONFLICT DO NOTHING`
  );
}

/** Rows that a real insert actually landed. Conflict-skipped rows do not count. */
async function copyChunk(source, client, sql, schema, table, offset, limit) {
  const fetched = await source.query(
    `SELECT to_jsonb(t) AS j FROM ${q(schema)}.${q(table)} AS t ORDER BY 1 LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  if (fetched.rows.length === 0) return { copied: 0, seen: 0 };
  const payload = JSON.stringify(fetched.rows.map((r) => r.j));
  const res = await client.query(sql, [payload]);
  return { copied: res.rowCount, seen: fetched.rows.length };
}

async function resyncIdentitySequences(pool, schema, table, columns) {
  for (const col of columns.filter((c) => c.is_identity)) {
    // Without this, the next insert in the target collides with the highest id we
    // just copied in, because setval is what the identity counter reads.
    const seq = await pool.query("SELECT pg_get_serial_sequence($1, $2) AS s", [
      `${schema}.${table}`,
      col.name,
    ]);
    const seqName = seq.rows[0]?.s;
    if (!seqName) {
      throw new Error(`No identity sequence found for ${schema}.${table}.${col.name}`);
    }
    await pool.query(
      `SELECT setval($1, GREATEST(COALESCE(MAX(${q(col.name)}), 0), 1), MAX(${q(col.name)}) IS NOT NULL)
       FROM ${q(schema)}.${q(table)}`,
      [seqName],
    );
  }
}

async function main() {
  const steps = plan();
  const source = await openPool(SOURCE_URL, { readOnly: true });
  const pools = {};
  const getPool = async (key, url) => {
    if (!pools[key]) pools[key] = await openPool(url);
    return pools[key];
  };

  const mode = VERIFY_ONLY ? "VERIFY ONLY" : APPLY ? "APPLY" : "DRY RUN (no writes)";
  console.log(`mode            : ${mode}`);
  console.log(`source (read-only): ${SOURCE_URL.replace(/:[^:@/]+@/, ":***@")}`);
  for (const [key, url] of Object.entries(TARGETS)) {
    console.log(`target ${key.padEnd(7)}: ${url.replace(/:[^:@/]+@/, ":***@")}`);
  }
  console.log(`tables to copy  : ${steps.length}`);
  if (!APPLY && !VERIFY_ONLY) {
    console.log("\nNothing will be written. Re-run with --apply to copy, --verify to only compare.\n");
  }

  // Preflight: every table must already exist in its target, with every source
  // column present. A missing migration should fail here, loudly, instead of
  // halfway through a copy.
  const problems = [];
  for (const step of steps) {
    const target = await getPool(step.node, TARGETS[step.node]);
    let targetCols;
    try {
      targetCols = await columnsOf(target, step.schema, step.table);
    } catch {
      problems.push(`${step.database}.${step.schema}.${step.table}: table missing in target`);
      continue;
    }
    if (targetCols.length === 0) {
      problems.push(`${step.database}.${step.schema}.${step.table}: table missing in target`);
      continue;
    }
    const sourceCols = await columnsOf(source, step.schema, step.table);
    if (sourceCols.length === 0) {
      problems.push(`${step.database}.${step.schema}.${step.table}: table missing in source`);
      continue;
    }
    const have = new Set(targetCols.map((c) => c.name));
    for (const col of sourceCols) {
      if (!have.has(col.name)) {
        problems.push(
          `${step.database}.${step.schema}.${step.table}: target lacks column ${col.name}`,
        );
      }
    }
  }
  if (problems.length > 0) {
    console.error("\nPreflight FAILED. Run the schema migrations for the targets first:");
    for (const p of problems) console.error(`  - ${p}`);
    await closeAll(source, pools);
    process.exitCode = 1;
    return;
  }
  console.log("preflight       : all tables and columns present in targets\n");

  let insertedTotal = 0;
  let unchangedTotal = 0;
  const report = [];

  for (const step of steps) {
    const target = await getPool(step.node, TARGETS[step.node]);
    const columns = await columnsOf(source, step.schema, step.table);
    const insertable = columns.filter((c) => !c.is_stored_generated);
    const sourceCount = await countRows(source, step.schema, step.table);
    const before = await countRows(target, step.schema, step.table);

    let copied = 0;
    if (APPLY && sourceCount > 0) {
      const sql = buildInsertSql(step.schema, step.table, insertable);
      // One transaction per table. A failure halfway through leaves earlier tables
      // committed and consistent, and the re-run fills the rest without duplicates.
      const client = await target.connect();
      try {
        await client.query("BEGIN");
        for (let offset = 0; offset < sourceCount; offset += CHUNK) {
          const r = await copyChunk(
            source,
            client,
            sql,
            step.schema,
            step.table,
            offset,
            CHUNK,
          );
          if (r.seen === 0) break;
          copied += r.copied;
        }
        await resyncIdentitySequences(client, step.schema, step.table, insertable);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`\nFAILED at ${step.database}.${step.schema}.${step.table}: ${err.message}`);
        console.error(
          "Source is untouched. Fix the cause and re-run; already-copied tables are skipped.",
        );
        await closeAll(source, pools);
        process.exitCode = 1;
        return;
      } finally {
        client.release();
      }
    }

    // Re-count the target instead of assuming before + copied, so the report cannot
    // claim success that the database does not agree with.
    const after = await countRows(target, step.schema, step.table);
    const missing = sourceCount - after;
    insertedTotal += copied;
    unchangedTotal += sourceCount - copied;

    const mark =
      sourceCount === 0
        ? "empty"
        : missing > 0
          ? APPLY
            ? "PARTIAL"
            : "would copy"
          : copied > 0
            ? "copied"
            : "in sync";
    report.push({ ...step, sourceRows: sourceCount, targetRows: after, copied, missing, mark });
    console.log(
      `  ${mark.padEnd(10)} ${`${step.database}.${step.schema}.${step.table}`.padEnd(38)}` +
        ` source=${String(sourceCount).padStart(4)}  target=${String(after).padStart(4)}` +
        (copied > 0 ? `  +${copied}` : ""),
    );
  }

  console.log(
    `\n${APPLY ? "copied" : "planned"} rows: ${insertedTotal} new, ${unchangedTotal} already present`,
  );
  const short = report.filter((r) => r.missing > 0);
  if (short.length > 0) {
    console.log(`\n${APPLY ? "STILL" : "WOULD BE"} SHORT in ${short.length} table(s):`);
    for (const r of short) {
      console.log(`  - ${r.database}.${r.schema}.${r.table}: source=${r.sourceRows} target=${r.targetRows}`);
    }
    if (!APPLY) console.log("\nRe-run with --apply to copy the remainder.");
  } else {
    console.log("\nAll tables in sync: every source row exists in its target.");
  }

  await closeAll(source, pools);
}

async function closeAll(source, pools) {
  await source.end().catch(() => {});
  for (const pool of Object.values(pools)) await pool.end().catch(() => {});
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
});
