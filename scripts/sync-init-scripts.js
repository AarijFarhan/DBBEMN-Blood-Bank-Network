/**
 * Generate init-scripts/00-common.sql and init-scripts/10-catalog.sql from the
 * canonical migrations in db/migrations/catalog/.
 *
 * Why generate instead of hand-writing: Docker init scripts and migrations would
 * otherwise be two independent copies of the same DDL, and they would silently
 * drift the first time someone edits a migration. Run this after changing any
 * file in that folder:  node scripts/sync-init-scripts.js
 *
 * Why classify by CONTENT rather than by folder: the folder only says where a
 * file was written, not what it does. db/migrations/catalog/002_donor_requests.sql
 * lives in the catalog folder but only creates common.donor_request_status_t,
 * which every city node needs. Classifying by folder put that enum on the
 * catalog node alone and the city nodes then failed to create donor_requests.
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogDir = path.resolve(here, "../db/migrations/catalog");
const outDir = path.resolve(here, "../init-scripts");

const CATALOG_MARKER = "CREATE SCHEMA IF NOT EXISTS catalog;";

const header = (title, applies) =>
  `-- GENERATED FILE - DO NOT EDIT BY HAND.
-- Source: db/migrations/catalog/*.sql
-- Regenerate: node scripts/sync-init-scripts.js
--
-- ${title}
-- Mounted on: ${applies}
`;

/**
 * Decide which nodes a migration file applies to by looking at which schemas it
 * references. Returns "mixed" when the file does both, in which case the caller
 * splits it at the point where the catalog schema is created.
 */
export function classify(sql) {
  const touchesCommon = /\bcommon\./.test(sql);
  const touchesCatalog = /\bcatalog\./.test(sql);
  if (touchesCommon && touchesCatalog) return "mixed";
  if (touchesCommon) return "common";
  if (touchesCatalog) return "catalog";
  return "none";
}

async function main() {
  const files = (await readdir(catalogDir)).filter((name) => name.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error(`No .sql migrations found in ${catalogDir}.`);

  const commonChunks = [];
  const catalogChunks = [];
  const plan = [];

  for (const name of files) {
    const raw = await readFile(path.join(catalogDir, name), "utf8");
    const kind = classify(raw);

    if (kind === "common") {
      commonChunks.push(`-- ---- ${name} ----\n${raw.trim()}`);
      plan.push(`${name} -> common (all nodes)`);
    } else if (kind === "catalog") {
      catalogChunks.push(`-- ---- ${name} ----\n${raw.trim()}`);
      plan.push(`${name} -> catalog only`);
    } else if (kind === "mixed") {
      const markerIndex = raw.indexOf(CATALOG_MARKER);
      if (markerIndex === -1) {
        throw new Error(`${name} touches both schemas but has no "${CATALOG_MARKER}" to split on.`);
      }
      commonChunks.push(`-- ---- ${name} (common half) ----\n${raw.slice(0, markerIndex).trimEnd()}`);
      catalogChunks.push(`-- ---- ${name} (catalog half) ----\n${raw.slice(markerIndex).trimEnd()}`);
      plan.push(`${name} -> split into common + catalog`);
    } else {
      plan.push(`${name} -> SKIPPED (references neither common. nor catalog.)`);
    }
  }

  if (commonChunks.length === 0) throw new Error("No common DDL found - refusing to write an empty 00-common.sql.");
  if (catalogChunks.length === 0) throw new Error("No catalog DDL found - refusing to write an empty 10-catalog.sql.");

  const common = commonChunks.join("\n\n");
  const catalog = catalogChunks.join("\n\n");

  await mkdir(outDir, { recursive: true });

  await writeFile(
    path.join(outDir, "00-common.sql"),
    `${header(
      "common schema: enums + helper functions, required by every city node",
      "ALL nodes (db-catalog, db-khi, db-lhe, db-isb)",
    )}\n${common}\n`,
    "utf8",
  );

  await writeFile(
    path.join(outDir, "10-catalog.sql"),
    `${header(
      "catalog schema: cities, hospitals, blood_banks, users, refresh_tokens, chaos_flags",
      "db-catalog ONLY - city nodes must never hold this",
    )}\n${catalog}\n`,
    "utf8",
  );

  for (const line of plan) process.stdout.write(`[sync-init] ${line}\n`);
  process.stdout.write(`[sync-init] wrote 00-common.sql (${common.split("\n").length} lines)\n`);
  process.stdout.write(`[sync-init] wrote 10-catalog.sql (${catalog.split("\n").length} lines)\n`);
}

main().catch((error) => {
  process.stderr.write(`[sync-init] failed: ${error.message}\n`);
  process.exitCode = 1;
});
