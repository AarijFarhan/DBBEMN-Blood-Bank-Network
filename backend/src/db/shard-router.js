export const CITY_CODES = Object.freeze(["KHI", "LHE", "ISB"]);

const CITY_CODE_SET = new Set(CITY_CODES);
const SCHEMA_PREFIX_PATTERN = /^(?:[a-z][a-z0-9_]{0,20})?$/;

export function schemaPrefix(value = process.env.SCHEMA_PREFIX ?? "") {
  if (typeof value !== "string" || !SCHEMA_PREFIX_PATTERN.test(value)) {
    throw new Error("SCHEMA_PREFIX must be empty or a short lowercase SQL-safe prefix.");
  }
  return value;
}

/**
 * Resolve only allow-listed city codes to schema identifiers.
 * Why: schema identifiers cannot be parameterized, so they must never come
 * from request data or unchecked environment input.
 */
export function schemasFor(cityCode, prefix = schemaPrefix()) {
  if (!CITY_CODE_SET.has(cityCode)) {
    throw new RangeError(`Unsupported city code: ${String(cityCode)}`);
  }

  const city = cityCode.toLowerCase();
  const safePrefix = schemaPrefix(prefix);

  return Object.freeze({
    hot: `${safePrefix}${city}_hot`,
    hist: `${safePrefix}${city}_history`,
    read: `${safePrefix}${city}_read`,
  });
}