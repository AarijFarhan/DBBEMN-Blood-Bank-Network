import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CITY_CODES, schemasFor } from "../db/shard-router.js";
import { withSerializableRetryFor } from "../db/pool.js";
import { getPoolForCity } from "../db/registry.js";
import { authenticate, requireBankScope, requireRole } from "../middleware/auth.js";
import { AppError, asyncRoute } from "../middleware/errors.js";
import { parseQuery } from "../middleware/validate.js";
import { getActiveBank } from "../services/catalog.js";
import { assertCityWritable } from "../services/chaos.js";
import {
  cacheGet,
  cacheSet,
  invalidateCityInventory,
  inventoryVersions,
  isSharedCache,
  versionToken,
} from "../cache/store.js";
import { KIND, locateAcrossCities } from "../services/presence.js";
import { EVENT_TYPES, publish } from "../lib/bus.js";
import { cityCodeSchema, uuidSchema } from "../utils/validators.js";

const router = Router();
const unitStatusSchema = z.enum([
  "QUARANTINE",
  "AVAILABLE",
  "RESERVED",
  "DISPATCHED",
  "TRANSFUSED",
  "EXPIRED",
  "DISCARDED",
]);
const unitsQuerySchema = z.object({
  bankId: uuidSchema.optional(),
  status: unitStatusSchema.optional(),
  city: cityCodeSchema.optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
const cityQuerySchema = z.object({ city: cityCodeSchema.optional() });

async function readUnit(unitId, cities) {
  return locateAcrossCities(KIND.UNIT, unitId, cities, async (cityCode) => {
    const { hot } = schemasFor(cityCode);
    const result = await getPoolForCity(cityCode).query(
      `SELECT unit_id AS "unitId", donation_id AS "donationId",
              blood_bank_id AS "bloodBankId", blood_group AS "bloodGroup",
              rh_factor AS "rhFactor", component_type AS "componentType",
              volume_ml AS "volumeMl", collected_on AS "collectedOn",
              expiry_date AS "expiryDate", status, version, updated_at AS "updatedAt"
       FROM ${hot}.blood_units
       WHERE unit_id = $1`,
      [unitId],
    );
    if (result.rowCount > 0) return { unit: result.rows[0], cityCode };
    return null;
  });
}

async function accessibleCities(req, requestedCity) {
  if (req.user.role === "BLOODBANK_ADMIN") {
    const bank = await getActiveBank(req.user.blood_bank_id);
    const city = bank.city_code.trim();
    if (requestedCity && requestedCity !== city) {
      throw new AppError(403, "TENANT_SCOPE_VIOLATION", "A blood bank can only access units in its city.");
    }
    return [city];
  }
  return requestedCity ? [requestedCity] : CITY_CODES;
}

router.get(
  "/units",
  authenticate,
  requireRole("BLOODBANK_ADMIN", "SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => {
    const query = parseQuery(unitsQuerySchema, req.query);
    let bankId = query.bankId ?? null;
    if (req.user.role === "BLOODBANK_ADMIN") {
      requireBankScope(req, bankId ?? req.user.blood_bank_id);
      bankId = req.user.blood_bank_id;
    }
    const cities = await accessibleCities(req, query.city);
    const offset = (query.page - 1) * query.limit;
    const fetchLimit = query.limit + 1;
    const isBankAdmin = req.user.role === "BLOODBANK_ADMIN";
    const cacheKey = isBankAdmin && isSharedCache()
      ? await (async () => {
          const versions = await inventoryVersions(cities);
          const fingerprint = createHash("sha256")
            .update(JSON.stringify({
              bankId,
              status: query.status ?? null,
              search: query.search ?? "",
              page: query.page,
              limit: query.limit,
            }))
            .digest("base64url");
          return `bank-units:v1:${fingerprint}:${versionToken(versions, cities)}`;
        })()
      : null;
    if (cacheKey) {
      const cached = await cacheGet(cacheKey);
      if (cached) {
        try {
          res.json(JSON.parse(cached));
          return;
        } catch {
          req.log?.warn({ cacheKey }, "ignoring invalid cached bank inventory payload");
        }
      }
    }
    const result = await Promise.all(
      cities.map(async (cityCode) => {
        const { hot, hist } = schemasFor(cityCode);
        const values = [];
        const conditions = [];
        if (bankId) {
          values.push(bankId);
          conditions.push(`u.blood_bank_id = $${values.length}::uuid`);
        }
        if (query.status) {
          values.push(query.status);
          conditions.push(`u.status = $${values.length}::common.unit_status_t`);
        }
        if (query.search) {
          values.push(`%${query.search}%`);
          const searchParam = `$${values.length}`;
          conditions.push(`(
            u.unit_id::text ILIKE ${searchParam}
            OR u.blood_group::text ILIKE ${searchParam}
            OR u.rh_factor::text ILIKE ${searchParam}
            OR u.component_type::text ILIKE ${searchParam}
            OR u.status::text ILIKE ${searchParam}
          )`);
        }
        const units = await getPoolForCity(cityCode).query(
          `SELECT u.unit_id AS "unitId", u.donation_id AS "donationId",
                  u.blood_bank_id AS "bloodBankId", u.blood_group AS "bloodGroup",
                  u.rh_factor AS "rhFactor", u.component_type AS "componentType",
                  u.volume_ml AS "volumeMl", u.collected_on AS "collectedOn",
                  u.expiry_date AS "expiryDate", u.status, u.version,
                  u.updated_at AS "updatedAt", d.notes AS "donationNotes"
           FROM ${hot}.blood_units u
           JOIN ${hist}.donations d ON d.donation_id = u.donation_id
           ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
           ORDER BY u.expiry_date, u.unit_id
           LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, fetchLimit, offset],
        );
        return units.rows;
      }),
    );
    const allRows = result.flat();
    const hasMore = allRows.length > query.limit;
    const units = hasMore ? allRows.slice(0, query.limit) : allRows;
    const payload = { units, page: query.page, limit: query.limit, hasMore };
    if (cacheKey) await cacheSet(cacheKey, JSON.stringify(payload), 15);
    res.json(payload);
  }),
);

router.get(
  "/units/:id",
  authenticate,
  requireRole("BLOODBANK_ADMIN", "SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    if (!id.success) throw new AppError(422, "VALIDATION_ERROR", "Unit ID must be a UUID.");
    const query = parseQuery(cityQuerySchema, req.query);
    const cities = await accessibleCities(req, query.city);
    const match = await readUnit(id.data, cities);
    if (!match) throw new AppError(404, "UNIT_NOT_FOUND", "The unit was not found.");
    requireBankScope(req, match.unit.bloodBankId);
    res.json({ unit: { ...match.unit, cityCode: match.cityCode } });
  }),
);

router.patch(
  "/units/:id/discard",
  authenticate,
  requireRole("BLOODBANK_ADMIN", "SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const body = z.object({ reason: z.string().trim().min(3).max(300).optional() }).safeParse(req.body);
    if (!id.success || !body.success) {
      throw new AppError(422, "VALIDATION_ERROR", "A valid unit ID and optional reason are required.");
    }
    const query = parseQuery(cityQuerySchema, req.query);
    const cities = await accessibleCities(req, query.city);

    // A discard is a write, so the shard is never skipped: presence narrowing
    // only applies to reads. Write attempts stay exhaustive so a stale index can
    // never hide a unit that an admin is trying to discard.
    for (const cityCode of cities) {
       const { hot } = schemasFor(cityCode);
       const changed = await withSerializableRetryFor(getPoolForCity(cityCode))(async (client) => {
         await assertCityWritable(client, cityCode);
         const current = await client.query(
          `SELECT unit_id, blood_bank_id, status
           FROM ${hot}.blood_units WHERE unit_id = $1 FOR UPDATE`,
          [id.data],
        );
        if (current.rowCount === 0) return null;
        requireBankScope(req, current.rows[0].blood_bank_id);
        if (!["QUARANTINE", "AVAILABLE"].includes(current.rows[0].status)) {
          throw new AppError(409, "UNIT_NOT_DISCARDABLE", "Only quarantined or available units may be discarded.");
        }
        const update = await client.query(
          `UPDATE ${hot}.blood_units SET status = 'DISCARDED'
           WHERE unit_id = $1 AND status IN ('QUARANTINE', 'AVAILABLE')
           RETURNING unit_id AS "unitId", status`,
          [id.data],
        );
        return { ...update.rows[0], cityCode, bloodBankId: current.rows[0].blood_bank_id };
      });
      if (changed) {
        // The unit left the searchable pool, so cached search and summary
        // entries for this city are now wrong.
        await invalidateCityInventory(cityCode);
        publish(EVENT_TYPES.UNIT_UPDATED, {
          cityCode,
          unitId: changed.unitId,
          bloodBankId: changed.bloodBankId,
          change: "discarded",
          status: changed.status,
        });
        res.json({ unit: changed });
        return;
      }
    }
    throw new AppError(404, "UNIT_NOT_FOUND", "The unit was not found.");
  }),
);

export default router;