import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { getCatalogPool, getPoolForCity } from "../db/registry.js";
import { CITY_CODES, schemasFor } from "../db/shard-router.js";
import { AppError } from "../middleware/errors.js";
import { getChaosFlags, measureReplicaLagMs } from "./chaos.js";
import { buildKey, recall, remember, withSingleFlight } from "../cache/searchCache.js";
import {
  isSharedReady,
  sharedDelete,
  sharedExpire,
  sharedHashGetAll,
  sharedHashSet,
} from "../cache/shared.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ module: "search" });

const GROUPS = new Set(["A", "B", "AB", "O"]);
const RH_FACTORS = new Set(["POS", "NEG"]);
const COMPONENTS = new Set(["WHOLE_BLOOD", "PRBC", "PLATELETS", "PLASMA"]);
const SORT_FIELDS = new Set(["expiryDate", "volumeMl", "collectedOn", "bloodGroup", "distance"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR_VERSION = 1;
const FAILURE_THRESHOLD = 5;
const HALF_OPEN_AFTER_MS = 10_000;
const circuitBreakers = new Map();

class ShardUnavailableError extends Error {
  constructor(cityCode) {
    super(`Search shard ${cityCode} is unavailable.`);
    this.name = "ShardUnavailableError";
    this.cityCode = cityCode;
  }
}

function addParameter(values, value) {
  values.push(value);
  return `$${values.length}`;
}

function normalizeCities(cities) {
  const normalized = [...new Set(cities ?? CITY_CODES)];
  if (normalized.length === 0 || normalized.some((city) => !CITY_CODES.includes(city))) {
    throw new AppError(422, "VALIDATION_ERROR", "At least one valid city is required.");
  }
  return normalized;
}

function parseCompatibleWith(value) {
  if (!value) return null;
  const match = /^(A|B|AB|O)(POS|NEG|\+|-)$/.exec(value);
  if (!match) throw new AppError(422, "VALIDATION_ERROR", "compatibleWith must look like A+.");
  return {
    group: match[1],
    rh: match[2] === "+" || match[2] === "POS" ? "POS" : "NEG",
  };
}

function isValidDate(value) {
  return DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function normalizeQuery(query) {
  const cities = normalizeCities(query.cities ?? query.city);
  const sortBy = query.sortBy ?? "expiryDate";
  const order = query.order ?? "asc";
  if (!SORT_FIELDS.has(sortBy)) throw new AppError(422, "VALIDATION_ERROR", "Unsupported search sort field.");
  if (order !== "asc" && order !== "desc") throw new AppError(422, "VALIDATION_ERROR", "order must be asc or desc.");
  if (query.bloodGroup && !GROUPS.has(query.bloodGroup)) {
    throw new AppError(422, "VALIDATION_ERROR", "Unsupported blood group.");
  }
  if (query.rh && !RH_FACTORS.has(query.rh)) {
    throw new AppError(422, "VALIDATION_ERROR", "Unsupported Rh factor.");
  }
  if (query.component && !COMPONENTS.has(query.component)) {
    throw new AppError(422, "VALIDATION_ERROR", "Unsupported component.");
  }
  if (query.expiresBefore && !isValidDate(query.expiresBefore)) {
    throw new AppError(422, "VALIDATION_ERROR", "expiresBefore must be an ISO date.");
  }
  if (query.expiresAfter && !isValidDate(query.expiresAfter)) {
    throw new AppError(422, "VALIDATION_ERROR", "expiresAfter must be an ISO date.");
  }
  if (query.expiresBefore && query.expiresAfter && query.expiresBefore < query.expiresAfter) {
    throw new AppError(422, "VALIDATION_ERROR", "expiresBefore must not precede expiresAfter.");
  }
  if (sortBy === "distance" && !query.fromHospitalId) {
    throw new AppError(422, "VALIDATION_ERROR", "fromHospitalId is required for distance sorting.");
  }
  return {
    ...query,
    cities,
    sortBy,
    order,
    limit: Math.min(100, Math.max(1, Number(query.limit ?? 50))),
    compatibleWith: query.compatibleWith ?? null,
  };
}

function queryFingerprint(query) {
  const canonical = {
    bloodGroup: query.bloodGroup ?? null,
    rh: query.rh ?? null,
    component: query.component ?? null,
    compatibleWith: query.compatibleWith ?? null,
    cities: [...query.cities].sort(),
    expiresBefore: query.expiresBefore ?? null,
    expiresAfter: query.expiresAfter ?? null,
    minVolumeMl: query.minVolumeMl ?? null,
    bankId: query.bankId ?? null,
    q: query.q ?? null,
    fromHospitalId: query.fromHospitalId ?? null,
    sortBy: query.sortBy,
    order: query.order,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function cursorSignature(body) {
  return createHmac("sha256", env.jwtSecret).update(body).digest("base64url");
}

export function encodeSearchCursor(payload) {
  const body = Buffer.from(JSON.stringify({ version: CURSOR_VERSION, ...payload })).toString("base64url");
  return `${body}.${cursorSignature(body)}`;
}

function invalidCursor() {
  return new AppError(422, "INVALID_CURSOR", "The search cursor is invalid or does not match the query.");
}

export function decodeSearchCursor(value, expected) {
  if (!value) return null;
  if (typeof value !== "string" || value.length > 2_000) throw invalidCursor();
  const parts = value.split(".");
  if (parts.length !== 2) throw invalidCursor();
  const [body, signature] = parts;
  const expectedSignature = cursorSignature(body);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw invalidCursor();
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (
    !payload ||
    payload.version !== CURSOR_VERSION ||
    payload.fingerprint !== expected.fingerprint ||
    payload.sortBy !== expected.sortBy ||
    payload.order !== expected.order ||
    !UUID_PATTERN.test(String(payload.unitId ?? ""))
  ) {
    throw invalidCursor();
  }
  if (payload.sortBy === "expiryDate" || payload.sortBy === "collectedOn") {
    if (!isValidDate(payload.value)) throw invalidCursor();
  } else if (payload.sortBy === "volumeMl") {
    if (!Number.isInteger(payload.value) || payload.value < 0) throw invalidCursor();
  } else if (payload.sortBy === "bloodGroup") {
    if (!GROUPS.has(payload.value) || !RH_FACTORS.has(payload.rhFactor)) throw invalidCursor();
  } else if (payload.sortBy === "distance") {
    if (!Number.isFinite(payload.value) || payload.value < 0) throw invalidCursor();
  } else {
    throw invalidCursor();
  }
  return payload;
}

function sourceTable(cityCode, source) {
  const { hot, read } = schemasFor(cityCode);
  return source === "replica" ? `${read}.units_search` : `${hot}.blood_units`;
}

/**
 * Bank coordinates resolved on the catalog node, ready to be passed to a shard.
 *
 * Why they have to come from the catalog: blood_banks and cities live on the
 * catalog node while blood_units lives on a city node, so the two can never be
 * joined in SQL on the shard. The catalog resolves the term once and the
 * shard filters on the resulting bank ids.
 *
 * The city fallback is applied HERE, on the catalog, exactly as the old
 * in-shard COALESCE(b.latitude, c.latitude) did - so the distance a client
 * sees is unchanged.
 */
async function loadBankCoordinates() {
  const result = await getCatalogPool().query(
    `SELECT b.blood_bank_id,
            COALESCE(b.latitude, c.latitude)::double precision AS latitude,
            COALESCE(b.longitude, c.longitude)::double precision AS longitude
     FROM catalog.blood_banks b
     JOIN catalog.cities c ON c.city_code = b.city_code`,
  );
  return {
    bankIds: result.rows.map((row) => row.blood_bank_id),
    latitudes: result.rows.map((row) => row.latitude),
    longitudes: result.rows.map((row) => row.longitude),
  };
}

/**
 * Resolve a free-text term to the set of blood banks it can match.
 *
 * The term is matched against the bank name, the city name and the city code,
 * which is the same set the old in-shard predicate used. A city that matches
 * contributes every bank in that city, because a hospital asking for "Lahore"
 * wants the whole city.
 */
async function resolveBankIdsForTerm(term) {
  const escaped = term.replace(/[!%_]/g, "!$&");
  const result = await getCatalogPool().query(
    `SELECT b.blood_bank_id
     FROM catalog.blood_banks b
     JOIN catalog.cities c ON c.city_code = b.city_code
     WHERE b.name ILIKE $1 ESCAPE '!'
        OR c.name ILIKE $1 ESCAPE '!'
        OR b.city_code ILIKE $1 ESCAPE '!'`,
    [`%${escaped}%`],
  );
  return result.rows.map((row) => row.blood_bank_id);
}

/**
 * Everything the catalog has to contribute to one search.
 *
 * Both the free-text filter and the distance sort are physically impossible to
 * evaluate on a shard, because the columns they need live on the catalog node.
 * The catalog is therefore not an optional enrichment here: it is part of the
 * query. When it is unreachable the query cannot be answered correctly, and
 * saying so is better than returning a silently wrong result set.
 */
async function loadCatalogContext(query) {
  const needsBankIds = Boolean(query.q);
  const needsCoordinates = query.sortBy === "distance";
  if (!needsBankIds && !needsCoordinates) {
    return { bankIds: null, coordinates: null };
  }
  try {
    const [bankIds, coordinates] = await Promise.all([
      needsBankIds ? resolveBankIdsForTerm(query.q) : Promise.resolve(null),
      needsCoordinates ? loadBankCoordinates() : Promise.resolve(null),
    ]);
    return { bankIds, coordinates };
  } catch (error) {
    log.warn({ err: error.message }, "catalog node unavailable for search");
    throw new AppError(
      503,
      "CATALOG_UNAVAILABLE",
      "The catalog node is unavailable, so this search cannot be resolved.",
      { cause: error.message },
      { "Retry-After": "5" },
    );
  }
}

/**
 * Parameters for the coordinate join, allocated once so the distance
 * expression and the join agree on the same placeholders.
 */
function coordinateParameters(values, coordinates) {
  if (!coordinates) return null;
  return {
    bankIds: addParameter(values, coordinates.bankIds),
    latitudes: addParameter(values, coordinates.latitudes),
    longitudes: addParameter(values, coordinates.longitudes),
  };
}

/**
 * Join the catalog-resolved coordinates onto the shard rows.
 *
 * LEFT JOIN, so a bank the catalog did not know about yields a NULL distance
 * rather than dropping the unit from the result set.
 */
function coordinateJoinClause(parameters) {
  if (!parameters) return "";
  return `LEFT JOIN unnest(
                ${parameters.bankIds}::uuid[],
                ${parameters.latitudes}::double precision[],
                ${parameters.longitudes}::double precision[]
              ) AS coord(bank_id, latitude, longitude) ON coord.bank_id = u.blood_bank_id`;
}

function distanceExpression(values, origin) {
  if (!origin) return null;
  const latitude = addParameter(values, origin.latitude);
  const longitude = addParameter(values, origin.longitude);
  return `(
    6371 * 2 * asin(
      sqrt(
        least(
          1::double precision,
          power(sin(radians(coord.latitude - ${latitude}::double precision) / 2), 2)
          + cos(radians(${latitude}::double precision))
          * cos(radians(coord.latitude))
          * power(sin(radians(coord.longitude - ${longitude}::double precision) / 2), 2)
        )
      )
    )
  )`;
}

function cursorPredicate(query, cursor, values, distance) {
  if (!cursor) return null;
  const comparator = query.order === "asc" ? ">" : "<";
  if (query.sortBy === "bloodGroup") {
    const group = addParameter(values, cursor.value);
    const rh = addParameter(values, cursor.rhFactor);
    const unitId = addParameter(values, cursor.unitId);
    return `(u.blood_group, u.rh_factor, u.unit_id) ${comparator} (${group}::common.blood_group_t, ${rh}::common.rh_t, ${unitId}::uuid)`;
  }
  const value = addParameter(values, cursor.value);
  const unitId = addParameter(values, cursor.unitId);
  if (query.sortBy === "distance") {
    return `(${distance}, u.unit_id) ${comparator} (${value}::double precision, ${unitId}::uuid)`;
  }
  const column = {
    expiryDate: "u.expiry_date",
    volumeMl: "u.volume_ml",
    collectedOn: "u.collected_on",
  }[query.sortBy];
  const cast = query.sortBy === "volumeMl" ? "smallint" : "date";
  return `(${column}, u.unit_id) ${comparator} (${value}::${cast}, ${unitId}::uuid)`;
}

function buildWhere(query, values, distance, cursor, context) {
  const clauses = ["u.expiry_date > CURRENT_DATE"];
  if (query.component) {
    clauses.push(`u.component_type = ${addParameter(values, query.component)}::common.component_t`);
  }
  if (query.bloodGroup) {
    clauses.push(`u.blood_group = ${addParameter(values, query.bloodGroup)}::common.blood_group_t`);
  }
  if (query.rh) {
    clauses.push(`u.rh_factor = ${addParameter(values, query.rh)}::common.rh_t`);
  }
  if (query.compatibleWith) {
    const compatibility = parseCompatibleWith(query.compatibleWith);
    const component = query.component ?? "PRBC";
    const group = addParameter(values, compatibility.group);
    const rh = addParameter(values, compatibility.rh);
    const compatibleComponent = addParameter(values, component);
    clauses.push(`(u.blood_group, u.rh_factor) IN (
      SELECT g, r FROM common.compatible_donor(
        ${group}::common.blood_group_t,
        ${rh}::common.rh_t,
        ${compatibleComponent}::common.component_t
      )
    )`);
  }
  if (query.bankId) {
    clauses.push(`u.blood_bank_id = ${addParameter(values, query.bankId)}::uuid`);
  }
  if (query.minVolumeMl !== undefined) {
    clauses.push(`u.volume_ml >= ${addParameter(values, query.minVolumeMl)}::smallint`);
  }
  if (query.expiresAfter) {
    clauses.push(`u.expiry_date >= ${addParameter(values, query.expiresAfter)}::date`);
  }
  if (query.expiresBefore) {
    clauses.push(`u.expiry_date <= ${addParameter(values, query.expiresBefore)}::date`);
  }
  if (query.q) {
    // The term was resolved to a set of bank ids on the catalog node; see
    // resolveBankIdsForTerm. A shard only knows blood_bank_id, so the filter
    // has to be pushed down as an id list rather than a name match.
    const bankIds = addParameter(values, context?.bankIds ?? []);
    clauses.push(`u.blood_bank_id = ANY(${bankIds}::uuid[])`);
  }
  const cursorClause = cursorPredicate(query, cursor, values, distance);
  if (cursorClause) clauses.push(cursorClause);
  return clauses.join(" AND ");
}

function buildSearchSql(cityCode, source, query, origin, cursor, limit, context) {
  const values = [];
  const coordinateParams = coordinateParameters(values, context?.coordinates ?? null);
  const distance = distanceExpression(values, query.sortBy === "distance" ? origin : null);
  const where = buildWhere(query, values, distance, cursor, context);
  const table = sourceTable(cityCode, source);
  const direction = query.order === "desc" ? "DESC" : "ASC";
  const sortExpression = query.sortBy === "distance"
    ? distance
    : `u.${({
      expiryDate: "expiry_date",
      volumeMl: "volume_ml",
      collectedOn: "collected_on",
      bloodGroup: "blood_group",
    }[query.sortBy])}`;
  const orderBy = query.sortBy === "bloodGroup"
    ? `u.blood_group ${direction}, u.rh_factor ${direction}, u.unit_id ${direction}`
    : `${sortExpression} ${direction} NULLS LAST, u.unit_id ${direction}`;
  const limitParameter = addParameter(values, limit + 1);
  const statusClause = source === "primary" ? "AND u.status = 'AVAILABLE'::common.unit_status_t" : "";
  const distanceSelect = distance ?? "NULL::double precision";
  const coordinateJoin = coordinateJoinClause(coordinateParams);
  const text = `
    SELECT u.unit_id AS "unitId",
           u.blood_bank_id AS "bloodBankId",
           u.blood_group::text AS "bloodGroup",
           u.rh_factor::text AS "rhFactor",
           u.component_type::text AS "componentType",
           u.volume_ml AS "volumeMl",
           u.collected_on AS "collectedOn",
           u.expiry_date AS "expiryDate",
           ${distanceSelect} AS "distanceKm"
    FROM ${table} u
    ${coordinateJoin}
    WHERE ${where} ${statusClause}
    ORDER BY ${orderBy}
    LIMIT ${limitParameter}`;
  return { text, values };
}

function buildSummarySql(cityCode, source, query, context) {
  const values = [];
  const where = buildWhere(query, values, null, null, context);
  const table = sourceTable(cityCode, source);
  const statusClause = source === "primary" ? "AND u.status = 'AVAILABLE'::common.unit_status_t" : "";
  const text = `
    SELECT u.blood_group::text AS "bloodGroup",
           u.rh_factor::text AS "rhFactor",
           u.component_type::text AS "componentType",
           count(*)::int AS "count"
    FROM ${table} u
    WHERE ${where} ${statusClause}
    GROUP BY u.blood_group, u.rh_factor, u.component_type
    ORDER BY u.blood_group, u.rh_factor, u.component_type`;
  return { text, values };
}

function getBreaker(cityCode) {
  let state = circuitBreakers.get(cityCode);
  if (!state) {
    state = { failures: 0, openUntil: 0, halfOpen: false };
    circuitBreakers.set(cityCode, state);
  }
  return state;
}

/**
 * Circuit breaker state, shared between instances.
 *
 * The breaker used to live in a Map, which meant a shard that was failing for
 * one instance was still being hammered by the other two - and each instance
 * reported a different view of the network to the client. The state now lives
 * in Redis so every instance sees the same breaker.
 *
 * A short-lived local mirror keeps the hot path (one check per shard per
 * request) off the network. Writes always read the shared state fresh, so a
 * burst of failures cannot hide behind the mirror.
 */
const BREAKER_MEMO_MS = 200;
const BREAKER_TTL_SECONDS = 120;
const breakerMemo = new Map();

function breakerName(cityCode) {
  return `breaker:search:${cityCode}`;
}

async function readBreaker(cityCode, fresh = false) {
  if (!fresh) {
    const memo = breakerMemo.get(cityCode);
    if (memo && Date.now() - memo.at < BREAKER_MEMO_MS) return memo.state;
  }
  let state;
  if (isSharedReady()) {
    const hash = await sharedHashGetAll(breakerName(cityCode));
    state = { failures: Number(hash.failures ?? 0), openUntil: Number(hash.openUntil ?? 0) };
  } else {
    state = circuitBreakers.get(cityCode) ?? { failures: 0, openUntil: 0, halfOpen: false };
  }
  breakerMemo.set(cityCode, { state, at: Date.now() });
  return state;
}

async function writeBreaker(cityCode, state) {
  breakerMemo.set(cityCode, { state, at: Date.now() });
  if (!isSharedReady()) {
    circuitBreakers.set(cityCode, state);
    return;
  }
  await sharedHashSet(breakerName(cityCode), "failures", state.failures);
  await sharedHashSet(breakerName(cityCode), "openUntil", state.openUntil);
  // The TTL is what retires a breaker for a shard that stopped failing: no
  // instance has to remember to close it.
  await sharedExpire(breakerName(cityCode), BREAKER_TTL_SECONDS);
}

async function canRead(cityCode) {
  const state = await readBreaker(cityCode);
  if (!state || state.openUntil === 0) return true;
  if (Date.now() < state.openUntil) return false;
  // The open window has passed: let one read through as a probe.
  return true;
}

async function markReadSuccess(cityCode) {
  breakerMemo.delete(cityCode);
  if (isSharedReady()) await sharedDelete(breakerName(cityCode));
  else circuitBreakers.delete(cityCode);
}

async function markFailure(cityCode) {
  const state = await readBreaker(cityCode, true);
  const halfOpen = state.openUntil !== 0 && Date.now() >= state.openUntil;
  const failures = state.failures + 1;
  const shouldOpen = halfOpen || failures >= FAILURE_THRESHOLD;
  await writeBreaker(cityCode, {
    failures: shouldOpen ? FAILURE_THRESHOLD : failures,
    openUntil: shouldOpen ? Date.now() + HALF_OPEN_AFTER_MS : 0,
  });
}

async function markPrimarySuccess(cityCode) {
  const state = await readBreaker(cityCode, true);
  if (state.openUntil === 0 && state.failures !== 0) {
    await writeBreaker(cityCode, { failures: 0, openUntil: 0 });
  }
}

export function resetSearchCircuitBreakers() {
  circuitBreakers.clear();
  breakerMemo.clear();
}

function timeoutError() {
  const error = new Error("The search shard query timed out.");
  error.code = "SEARCH_TIMEOUT";
  return error;
}

async function withShardTimeout(task, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runShard(cityCode, flag, queryForSource) {
  const deadline = Date.now() + env.searchShardTimeoutMs;
  if (!flag.replicaDown && (await canRead(cityCode))) {
    try {
      const result = await withShardTimeout(() => queryForSource(cityCode, "replica"), deadline);
      await markReadSuccess(cityCode);
      return { result, source: "SIMULATED_REPLICA" };
    } catch {
      await markFailure(cityCode);
    }
  }
  if (flag.primaryDown) throw new ShardUnavailableError(cityCode);
  try {
    const result = await withShardTimeout(() => queryForSource(cityCode, "primary"), deadline);
    await markPrimarySuccess(cityCode);
    return { result, source: "PRIMARY_FALLBACK" };
  } catch {
    await markFailure(cityCode);
    throw new ShardUnavailableError(cityCode);
  }
}

async function scatterGather(cities, flags, queryForSource) {
  const settled = await Promise.allSettled(
    cities.map((cityCode) => runShard(cityCode, flags[cityCode], queryForSource)),
  );
  const responses = [];
  const unavailableCities = [];
  settled.forEach((result, index) => {
    const cityCode = cities[index];
    if (result.status === "fulfilled") {
      responses.push({ cityCode, ...result.value });
    } else {
      unavailableCities.push(cityCode);
    }
  });
  return { responses, unavailableCities };
}

function dateString(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * Resolve bank and city display names from the catalog node.
 *
 * Why this is a separate step: blood_units lives on a city node while
 * catalog.blood_banks and catalog.cities live on the catalog node, so they can
 * never share a SQL join once the nodes are separate. The shard query therefore
 * returns only blood_bank_id, and the names are joined in the application.
 *
 * One batched query per search rather than one per shard: the enrichment set is
 * small (distinct bank ids on the page) and a single catalog round trip is
 * cheaper than fanning it out again.
 */
async function loadBankDirectory(bankIds) {
  const unique = [...new Set(bankIds.filter(Boolean))];
  if (unique.length === 0) return { directory: new Map(), degraded: false };

  try {
    const result = await getCatalogPool().query(
      `SELECT b.blood_bank_id AS "bloodBankId", b.name, c.name AS "cityName"
       FROM catalog.blood_banks b
       JOIN catalog.cities c ON c.city_code = b.city_code
       WHERE b.blood_bank_id = ANY($1::uuid[])`,
      [unique],
    );

    return { directory: new Map(result.rows.map((row) => [row.bloodBankId, row])), degraded: false };
  } catch (error) {
    // The names are decoration on top of the units, not the answer itself. The
    // shard already returned real rows, so losing the directory costs labels,
    // not data - and the caller is told about it in meta.warnings instead of
    // receiving a 500 for a request that was fully answerable.
    log.warn({ err: error.message }, "bank directory unavailable; returning units without names");
    return { directory: new Map(), degraded: true };
  }
}

function mapUnit(row, cityCode, directory) {
  const bank = directory?.get(row.bloodBankId) ?? null;
  const unit = {
    unitId: row.unitId,
    bloodBankId: row.bloodBankId,
    bloodGroup: row.bloodGroup,
    rh: row.rhFactor,
    rhFactor: row.rhFactor,
    component: row.componentType,
    componentType: row.componentType,
    volumeMl: Number(row.volumeMl),
    collectedOn: dateString(row.collectedOn),
    expiryDate: dateString(row.expiryDate),
    status: "AVAILABLE",
    cityCode,
    bankName: bank?.name ?? null,
    cityName: bank?.cityName ?? null,
  };
  if (row.distanceKm !== null && row.distanceKm !== undefined) unit.distanceKm = Number(row.distanceKm);
  return unit;
}

function isMissing(value) {
  return value === null || value === undefined;
}

function compareValues(left, right) {
  if (left === right) return 0;
  if (isMissing(left)) return 1;
  if (isMissing(right)) return -1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The value a unit is ordered by.
 *
 * Only `distance` can be absent - a unit whose bank has no usable coordinates
 * and no city fallback - but the shape stays generic so a new sort key cannot
 * silently reintroduce the "missing value sorts first" bug.
 */
function orderValue(unit, query) {
  switch (query.sortBy) {
    case "expiryDate": return unit.expiryDate;
    case "volumeMl": return unit.volumeMl;
    case "collectedOn": return unit.collectedOn;
    case "bloodGroup": return unit.bloodGroup;
    case "distance": return unit.distanceKm ?? null;
    default: return unit[query.sortBy] ?? null;
  }
}

function compareUnits(left, right, query) {
  const descending = query.order === "desc";
  const leftValue = orderValue(left, query);
  const rightValue = orderValue(right, query);

  // A unit with no value for the sort key always sorts last, in BOTH
  // directions. compareValues() treats a missing value as "greater", so the
  // descending flip would otherwise float those units to the top of a
  // descending page - exactly where a caller searching for the nearest blood
  // does not expect to find them. The check therefore has to happen after the
  // direction is known but before the comparison is negated.
  if (isMissing(leftValue) !== isMissing(rightValue)) {
    return isMissing(leftValue) ? 1 : -1;
  }

  let comparison;
  if (query.sortBy === "bloodGroup") {
    comparison = compareValues(left.bloodGroup, right.bloodGroup) || compareValues(left.rhFactor, right.rhFactor);
  } else comparison = compareValues(leftValue, rightValue);
  if (comparison === 0) comparison = compareValues(left.unitId, right.unitId);
  return descending ? -comparison : comparison;
}

function cursorValue(unit, sortBy) {
  if (sortBy === "bloodGroup") return { value: unit.bloodGroup, rhFactor: unit.rhFactor, unitId: unit.unitId };
  const value = sortBy === "volumeMl"
    ? unit.volumeMl
    : sortBy === "distance"
      ? unit.distanceKm
      : unit[sortBy];
  return { value, unitId: unit.unitId };
}

async function loadDistanceOrigin(query) {
  if (query.sortBy !== "distance") return null;
  let result;
  try {
    result = await getCatalogPool().query(`SELECT h.hospital_id, h.is_active,
              COALESCE(h.latitude, c.latitude) AS latitude,
              COALESCE(h.longitude, c.longitude) AS longitude
       FROM catalog.hospitals h
       JOIN catalog.cities c ON c.city_code = h.city_code
       WHERE h.hospital_id = $1`,
      [query.fromHospitalId],
    );
  } catch (error) {
    // Unlike the display names, the origin is not decoration: without it the
    // distance sort cannot be computed at all, and answering with a different
    // ordering than the one that was asked for would be a silent lie.
    log.warn({ err: error.message }, "catalog node unavailable for distance origin");
    throw new AppError(
      503,
      "CATALOG_UNAVAILABLE",
      "The catalog node is unavailable, so the distance origin cannot be resolved.",
      { cause: error.message },
      { "Retry-After": "5" },
    );
  }
  const hospital = result.rows[0];
  if (!hospital?.is_active) throw new AppError(404, "HOSPITAL_NOT_FOUND", "The origin hospital was not found or is inactive.");
  if (hospital.latitude === null || hospital.longitude === null) {
    throw new AppError(422, "HOSPITAL_COORDINATES_REQUIRED", "The origin hospital has no coordinates.");
  }
  return { latitude: Number(hospital.latitude), longitude: Number(hospital.longitude) };
}

async function collectLags(cities) {
  const entries = await Promise.all(cities.map(async (cityCode) => {
    try {
      return [cityCode, await measureReplicaLagMs(cityCode)];
    } catch {
      return [cityCode, 0];
    }
  }));
  return Object.fromEntries(entries);
}

function sourceForResponses(responses, flags, cities) {
  if (responses.some((response) => response.source === "PRIMARY_FALLBACK")) return "PRIMARY_FALLBACK";
  if (responses.length === 0 && cities.some((cityCode) => flags[cityCode]?.replicaDown)) return "PRIMARY_FALLBACK";
  return "SIMULATED_REPLICA";
}

/**
 * Cache key for one scatter-gather read.
 *
 * The cursor is folded in separately because it selects a different slice of the
 * same sorted result set: page 2 and page 1 share a query fingerprint but are
 * not interchangeable, and a version bump alone would not separate them.
 */
async function buildSearchCacheKey(namespace, fingerprint, cursor, cities) {
  if (!env.cache.enabled) return null;
  const identity = cursor ? `${fingerprint}|cursor=${cursor}` : fingerprint;
  return buildKey(namespace, identity, cities);
}

function makeMeta(cities, responses, unavailableCities, flags, source) {
  return {
    shardsQueried: cities.length,
    shardsResponded: responses.length,
    unavailableCities,
    partial: unavailableCities.length > 0,
    replicaLagMs: null,
    source,
    citySources: Object.fromEntries(responses.map((response) => [response.cityCode, response.source])),
    // Non-fatal degradations the caller should know about: the answer is
    // usable but something in it is missing.
    warnings: [],
  };
}

export async function searchUnits(input) {
  const query = normalizeQuery(input);
  const fingerprint = queryFingerprint(query);
  const cursor = decodeSearchCursor(query.cursor, {
    fingerprint,
    sortBy: query.sortBy,
    order: query.order,
  });
  const origin = await loadDistanceOrigin(query);
  const context = await loadCatalogContext(query);
  const flags = await getChaosFlags();

  // Version-stamped read-through. A hit is only served when it was built from a
  // complete read against the current topology, so it cannot under-report stock
  // or claim a replica read that no longer happens.
  const cacheKey = await buildSearchCacheKey("search", fingerprint, query.cursor, query.cities);
  const cached = cacheKey ? await recall(cacheKey, { cities: query.cities, flags }) : null;
  if (cached) {
    return { ...cached, cache: { status: "HIT" } };
  }

  // Single-flight: a key that a dozen clients miss at once is computed once,
  // not a dozen times. Each of those computations is a scatter-gather across
  // every shard, so the stampede lands on the database exactly when it is
  // already busy.
  const { value, fromCache } = await withSingleFlight(
    cacheKey,
    { cities: query.cities, flags },
    async () => {
      const scattered = await scatterGather(query.cities, flags, async (cityCode, source) =>
        sourceQueryForCity(cityCode, query, source, origin, cursor, context));
      const units = [];
      const seen = new Set();
      for (const response of scattered.responses) {
        for (const row of response.result) {
          if (seen.has(row.unitId)) continue;
          seen.add(row.unitId);
          units.push(mapUnit(row, response.cityCode));
        }
      }
      units.sort((left, right) => compareUnits(left, right, query));
      const page = units.slice(0, query.limit);
      const { directory, degraded } = await loadBankDirectory(page.map((unit) => unit.bloodBankId));
      for (const unit of page) {
        const bank = directory.get(unit.bloodBankId);
        if (bank) {
          unit.bankName = bank.name;
          unit.cityName = bank.cityName;
        }
      }
      const lastUnit = page.at(-1);
      // A unit with no value for the sort key cannot be expressed as a cursor
      // position: the SQL predicate compares the sort value, and a NULL never
      // compares true, so the next page could not be built from it anyway.
      // Emitting a cursor would hand the client a token that fails to decode, so
      // the page is ended here instead and the caller is told why.
      const cursorable = lastUnit && !isMissing(orderValue(lastUnit, query));
      const nextCursor = units.length > query.limit && cursorable
        ? encodeSearchCursor({ ...cursorValue(lastUnit, query.sortBy), fingerprint, sortBy: query.sortBy, order: query.order })
        : null;
      const source = sourceForResponses(scattered.responses, flags, query.cities);
      const meta = makeMeta(query.cities, scattered.responses, scattered.unavailableCities, flags, source);
      if (degraded) meta.warnings.push("BANK_DIRECTORY_UNAVAILABLE");
      if (!cursorable && units.length > query.limit) meta.warnings.push("CURSOR_STOPPED_AT_MISSING_SORT_VALUE");
      meta.replicaLagMs = await collectLags(query.cities);
      const result = { units: page, nextCursor, meta };

      if (cacheKey) {
        await remember(cacheKey, result, {
          cities: query.cities,
          flags,
          // Any missing shard means this answer is a subset of reality. Caching it
          // would keep hiding real stock after the shard recovered.
          complete: scattered.unavailableCities.length === 0,
          ttlSeconds: env.cache.searchTtlSeconds,
        });
      }
      return result;
    },
  );

  return { ...value, cache: { status: fromCache ? "HIT" : "MISS" } };
}

async function sourceQueryForCity(cityCode, query, source, origin, cursor, context) {
  const statement = buildSearchSql(cityCode, source, query, origin, cursor, query.limit, context);
  const result = await getPoolForCity(cityCode).query(statement.text, statement.values);
  return result.rows;
}

export async function stockSummary(input) {
  const query = normalizeQuery({ ...input, sortBy: "expiryDate", order: "asc" });
  const context = await loadCatalogContext(query);
  const flags = await getChaosFlags();

  // Same rules as searchUnits: version-stamped, and only ever cached when the
  // read was complete.
  const cacheKey = await buildSearchCacheKey("summary", queryFingerprint(query), null, query.cities);
  const cached = cacheKey ? await recall(cacheKey, { cities: query.cities, flags }) : null;
  if (cached) {
    return { ...cached, cache: { status: "HIT" } };
  }

  // Single-flight, same as the search path: one scatter-gather per key, no
  // matter how many clients ask for it at once.
  const { value, fromCache } = await withSingleFlight(
    cacheKey,
    { cities: query.cities, flags },
    async () => {
      const scattered = await scatterGather(query.cities, flags, async (cityCode, source) => {
        const statement = buildSummarySql(cityCode, source, query, context);
        const result = await getPoolForCity(cityCode).query(statement.text, statement.values);
        return result.rows;
      });
      const summary = [];
      for (const response of scattered.responses) {
        for (const row of response.result) {
          summary.push({
            cityCode: response.cityCode,
            bloodGroup: row.bloodGroup,
            rh: row.rhFactor,
            rhFactor: row.rhFactor,
            component: row.componentType,
            componentType: row.componentType,
            count: Number(row.count),
          });
        }
      }
      const source = sourceForResponses(scattered.responses, flags, query.cities);
      const meta = makeMeta(query.cities, scattered.responses, scattered.unavailableCities, flags, source);
      meta.replicaLagMs = await collectLags(query.cities);
      const byCity = Object.fromEntries(query.cities.map((cityCode) => [
        cityCode,
        summary.filter((row) => row.cityCode === cityCode),
      ]));
      const result = { summary, counts: summary, byCity, meta };

      if (cacheKey) {
        await remember(cacheKey, result, {
          cities: query.cities,
          flags,
          // A per-city count that silently omits a down shard is a lie a caller
          // cannot detect, so it must never be served from cache.
          complete: scattered.unavailableCities.length === 0,
          ttlSeconds: env.cache.summaryTtlSeconds,
        });
      }
      return result;
    },
  );

  return { ...value, cache: { status: fromCache ? "HIT" : "MISS" } };
}
