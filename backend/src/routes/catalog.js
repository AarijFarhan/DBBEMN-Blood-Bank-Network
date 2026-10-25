import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { CITY_CODES, schemasFor } from "../db/shard-router.js";
import { getCatalogPool, getPoolForCity } from "../db/registry.js";
import { withSerializableRetryFor } from "../db/pool.js";
import { runSaga, restoreRows } from "../db/saga.js";
import { authenticate, requireRole } from "../middleware/auth.js";
import { AppError, asyncRoute } from "../middleware/errors.js";
import { parseQuery } from "../middleware/validate.js";
import { validate } from "../middleware/validate.js";
import { cityCodeSchema, createBloodBankWithAdminSchema, createHospitalWithAdminSchema, createUserSchema, donorDeleteQuerySchema, entityIdParamSchema } from "../utils/validators.js";

const router = Router();
const cityQuerySchema = z.object({
  city: cityCodeSchema.optional(),
  search: z.string().trim().max(100).optional(),
});
const adminUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(100).optional(),
  city: cityCodeSchema.optional(),
  role: z.enum(["SYSTEM_ADMIN", "HOSPITAL_ADMIN", "BLOODBANK_ADMIN", "DONOR"]).optional(),
});

function sagaLog(event) {
  const detail = event.error ? ` (${event.error})` : "";
  process.stdout.write(`[saga:${event.saga}] ${event.step} ${event.status}${detail}\n`);
}

/**
 * Run a callback inside a SERIALIZABLE transaction on one city's node.
 * Every saga step is node-local: a transaction cannot span two connections, so
 * the saga boundary, not the transaction, is what provides atomicity.
 */
function onCity(cityCode, callback) {
  return withSerializableRetryFor(getPoolForCity(cityCode))(callback);
}

function onCatalog(callback) {
  return withSerializableRetryFor(getCatalogPool())(callback);
}

/**
 * Build the "undo runner" for a step: it re-opens a brand new SERIALIZABLE
 * transaction on the SAME node the step committed to.
 *
 * Why this is mandatory and not just tidier: a step's client is released the
 * moment its transaction commits. A compensation closure that captured that
 * client would run its INSERTs on a released connection, so every rollback
 * would either throw or silently write to whatever connection now owns the
 * slot. Compensating transactions must acquire their own client.
 */
function reopenOn(run) {
  return (undo) => run(undo);
}

/**
 * Remove rows that hang off a set of blood units, deepest child first, and hand
 * back an undo action that puts every captured row back.
 * Why: only reservations.reservation/unit carry real foreign keys, but the
 * outbox, read model, status log and transfusion rows reference units by bare
 * uuid and would be left orphaned by a plain cascade.
 */
async function purgeUnits(client, reopen, { hot, hist, read }, unitIds) {
  if (unitIds.length === 0) {
    return {
      counts: { transfusions: 0, reservations: 0, statusLog: 0, outbox: 0, readModel: 0 },
      compensate: async () => 0,
    };
  }
  const captured = {};
  const targets = [
    ["transfusions", `${hist}.transfusions`],
    ["reservations", `${hot}.reservations`],
    ["statusLog", `${hist}.unit_status_log`],
    ["outbox", `${hot}.outbox`],
    ["readModel", `${read}.units_search`],
  ];
  const counts = {};
  for (const [key, table] of targets) {
    const result = await client.query(`DELETE FROM ${table} WHERE unit_id = ANY($1) RETURNING *`, [unitIds]);
    captured[key] = { table, rows: result.rows };
    counts[key] = result.rowCount;
  }

  const compensate = () =>
    reopen(async (undo) => {
      let restored = 0;
      // Reverse of the delete order so foreign keys stay satisfied.
      for (const key of ["readModel", "outbox", "statusLog", "reservations", "transfusions"]) {
        const entry = captured[key];
        if (entry.rows.length === 0) continue;
        restored += await restoreRows(entry.table)(undo, entry.rows);
      }
      return restored;
    });

  return { counts, compensate };
}

/**
 * DELETE ... RETURNING * plus the matching undo action.
 * `reopen` must come from `reopenOn(...)` for the same node as `client`.
 */
async function captureDelete(client, reopen, table, where, params) {
  const result = await client.query(`DELETE FROM ${table} WHERE ${where} RETURNING *`, params);
  return {
    table,
    rows: result.rows,
    count: result.rowCount,
    compensate: () => reopen((undo) => restoreRows(table)(undo, result.rows)),
  };
}

router.get(
  "/cities",
  asyncRoute(async (_req, res) => {
    const result = await getCatalogPool().query(
      `SELECT city_code AS "cityCode", name, latitude, longitude
       FROM catalog.cities ORDER BY name`,
    );
    res.json({ cities: result.rows });
  }),
);

router.get(
  "/hospitals",
  asyncRoute(async (req, res) => {
    const { city, search } = parseQuery(cityQuerySchema, req.query);
    const result = await getCatalogPool().query(
      `SELECT hospital_id AS "hospitalId", name, city_code AS "cityCode",
              address, latitude, longitude, phone
       FROM catalog.hospitals
       WHERE is_active
         AND ($1::char(3) IS NULL OR city_code = $1)
         AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%'
              OR COALESCE(address, '') ILIKE '%' || $2 || '%'
              OR COALESCE(phone, '') ILIKE '%' || $2 || '%')
       ORDER BY city_code, name`,
      [city ?? null, search || null],
    );
    res.json({ hospitals: result.rows });
  }),
);

router.get(
  "/blood-banks",
  asyncRoute(async (req, res) => {
    const { city, search } = parseQuery(cityQuerySchema, req.query);
    const result = await getCatalogPool().query(
      `SELECT blood_bank_id AS "bloodBankId", name, city_code AS "cityCode",
              address, latitude, longitude, phone
       FROM catalog.blood_banks
       WHERE is_active
         AND ($1::char(3) IS NULL OR city_code = $1)
         AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%'
              OR COALESCE(address, '') ILIKE '%' || $2 || '%'
              OR COALESCE(phone, '') ILIKE '%' || $2 || '%')
       ORDER BY city_code, name`,
      [city ?? null, search || null],
    );
    res.json({ bloodBanks: result.rows });
  }),
);

router.get(
  "/admin/users",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => {
    const { page, limit, search, city, role } = parseQuery(adminUsersQuerySchema, req.query);
    const offset = (page - 1) * limit;
    const values = [];
    const conditions = [];
    if (search) {
      values.push(search);
      conditions.push(`(u.username ILIKE '%' || $${values.length} || '%'
         OR u.email ILIKE '%' || $${values.length} || '%'
         OR h.name ILIKE '%' || $${values.length} || '%'
         OR b.name ILIKE '%' || $${values.length} || '%')`);
    }
    if (city) {
      values.push(city);
      conditions.push(`COALESCE(h.city_code, b.city_code, u.donor_city_code) = $${values.length}::char(3)`);
    }
    if (role) {
      values.push(role);
      conditions.push(`u.role = $${values.length}`);
    }
    const filter = conditions.length ? conditions.join(" AND ") : "TRUE";
    const catalog = getCatalogPool();
    const [result, count] = await Promise.all([
      catalog.query(
        `SELECT u.user_id AS "userId", u.username, u.email, u.role,
              u.hospital_id AS "hospitalId", u.blood_bank_id AS "bloodBankId",
              u.donor_id AS "donorId", u.donor_city_code AS "donorCityCode",
              COALESCE(h.city_code, b.city_code, u.donor_city_code) AS "cityCode",
              u.is_active AS "isActive", u.created_at AS "createdAt"
         FROM catalog.users u
         LEFT JOIN catalog.hospitals h ON h.hospital_id = u.hospital_id
         LEFT JOIN catalog.blood_banks b ON b.blood_bank_id = u.blood_bank_id
         WHERE ${filter}
         ORDER BY u.role, u.username
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset],
      ),
      conditions.length
        ? catalog.query(
            `SELECT count(*)::int AS total
             FROM catalog.users u
             LEFT JOIN catalog.hospitals h ON h.hospital_id = u.hospital_id
             LEFT JOIN catalog.blood_banks b ON b.blood_bank_id = u.blood_bank_id
             WHERE ${filter}`,
            values,
          )
        : catalog.query(
            `SELECT GREATEST(reltuples, 0)::bigint AS total
             FROM pg_class
             WHERE oid = 'catalog.users'::regclass`,
          ),
    ]);
    const total = Number(count.rows[0]?.total ?? 0);
    const donorIdsByCity = new Map();
    for (const user of result.rows) {
      if (user.role !== "DONOR" || !user.donorId || !user.donorCityCode) continue;
      const cityCode = user.donorCityCode.trim();
      if (!donorIdsByCity.has(cityCode)) donorIdsByCity.set(cityCode, []);
      donorIdsByCity.get(cityCode).push(user.donorId);
    }
    const donorNames = new Map();
    await Promise.all(
      [...donorIdsByCity].map(async ([cityCode, donorIds]) => {
        const { hist } = schemasFor(cityCode);
        const donors = await getPoolForCity(cityCode).query(
          `SELECT donor_id AS "donorId", full_name AS "fullName"
           FROM ${hist}.donors
           WHERE donor_id = ANY($1::uuid[])`,
          [donorIds],
        );
        for (const donor of donors.rows) {
          donorNames.set(`${cityCode}:${donor.donorId}`, donor.fullName);
        }
      }),
    );
    const users = result.rows.map((user) => ({
      ...user,
      donorName: user.role === "DONOR"
        ? donorNames.get(`${user.donorCityCode?.trim()}:${user.donorId}`) ?? null
        : null,
    }));
    res.json({
      users,
      page,
      limit,
      total,
      totalApproximate: conditions.length === 0,
      hasMore: offset + result.rows.length < total,
    });
  }),
);

router.post(
  "/admin/hospitals",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  validate(createHospitalWithAdminSchema),
  asyncRoute(async (req, res) => {
    const body = req.body;
    const passwordHash = await bcrypt.hash(body.password, 12);
    const client = await getCatalogPool().connect();
    try {
      await client.query("BEGIN");
      const hospitalResult = await client.query(
        `INSERT INTO catalog.hospitals
           (name, city_code, address, latitude, longitude, phone)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING hospital_id AS "hospitalId", name, city_code AS "cityCode",
                   address, latitude, longitude, phone, is_active AS "isActive"`,
        [
          body.name,
          body.cityCode,
          body.address ?? null,
          body.latitude ?? null,
          body.longitude ?? null,
          body.phone ?? null,
        ],
      );
      const hospital = hospitalResult.rows[0];
      const userResult = await client.query(
        `INSERT INTO catalog.users
           (username, email, password_hash, role, hospital_id)
         VALUES ($1, $2, $3, 'HOSPITAL_ADMIN', $4)
         RETURNING user_id AS "userId", username, email, role,
                   hospital_id AS "hospitalId"`,
        [body.username, body.email, passwordHash, hospital.hospitalId],
      );
      await client.query("COMMIT");
      res.status(201).json({ hospital, user: userResult.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        throw new AppError(409, "ACCOUNT_ALREADY_EXISTS", "That username or email is already registered.");
      }
      throw error;
    } finally {
      client.release();
    }
  }),
);

router.post(
  "/admin/blood-banks",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  validate(createBloodBankWithAdminSchema),
  asyncRoute(async (req, res) => {
    const body = req.body;
    const passwordHash = await bcrypt.hash(body.password, 12);
    const client = await getCatalogPool().connect();
    try {
      await client.query("BEGIN");
      const bankResult = await client.query(
        `INSERT INTO catalog.blood_banks
           (name, city_code, address, latitude, longitude, phone)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING blood_bank_id AS "bloodBankId", name, city_code AS "cityCode",
                   address, latitude, longitude, phone, is_active AS "isActive"`,
        [
          body.name,
          body.cityCode,
          body.address ?? null,
          body.latitude ?? null,
          body.longitude ?? null,
          body.phone ?? null,
        ],
      );
      const bloodBank = bankResult.rows[0];
      const userResult = await client.query(
        `INSERT INTO catalog.users
           (username, email, password_hash, role, blood_bank_id)
         VALUES ($1, $2, $3, 'BLOODBANK_ADMIN', $4)
         RETURNING user_id AS "userId", username, email, role,
                   blood_bank_id AS "bloodBankId"`,
        [body.username, body.email, passwordHash, bloodBank.bloodBankId],
      );
      await client.query("COMMIT");
      res.status(201).json({ bloodBank, user: userResult.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        throw new AppError(409, "ACCOUNT_ALREADY_EXISTS", "That username or email is already registered.");
      }
      throw error;
    } finally {
      client.release();
    }
  }),
);

router.post(
  "/admin/users",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  validate(createUserSchema),
  asyncRoute(async (req, res) => {
    const body = req.body;
    const requiredFields = {
      SYSTEM_ADMIN: [],
      HOSPITAL_ADMIN: ["hospitalId"],
      BLOODBANK_ADMIN: ["bloodBankId"],
      DONOR: ["donorId", "donorCityCode"],
    }[body.role];
    const missingFields = requiredFields.filter((field) => !body[field]);
    if (missingFields.length > 0) {
      throw new AppError(422, "VALIDATION_ERROR", "Fields required for this role are missing.", {
        fields: missingFields,
      });
    }
    if (body.role === "HOSPITAL_ADMIN") {
      const exists = await getCatalogPool().query(
        "SELECT 1 FROM catalog.hospitals WHERE hospital_id = $1 AND is_active",
        [body.hospitalId],
      );
      if (exists.rowCount === 0) throw new AppError(422, "INVALID_HOSPITAL", "The hospital does not exist or is inactive.");
    }
    if (body.role === "BLOODBANK_ADMIN") {
      const exists = await getCatalogPool().query(
        "SELECT 1 FROM catalog.blood_banks WHERE blood_bank_id = $1 AND is_active",
        [body.bloodBankId],
      );
      if (exists.rowCount === 0) throw new AppError(422, "INVALID_BLOOD_BANK", "The blood bank does not exist or is inactive.");
    }
    if (body.role === "DONOR") {
      const { hist } = schemasFor(body.donorCityCode);
      const donor = await getPoolForCity(body.donorCityCode).query(
        `SELECT 1 FROM ${hist}.donors WHERE donor_id = $1`,
        [body.donorId],
      );
      if (donor.rowCount === 0) throw new AppError(422, "INVALID_DONOR", "The donor does not exist in that city.");
    }

    const passwordHash = await bcrypt.hash(body.password, 12);
    try {
      const result = await getCatalogPool().query(
        `INSERT INTO catalog.users
           (username, email, password_hash, role, hospital_id, blood_bank_id,
            donor_id, donor_city_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING user_id AS "userId", username, email, role,
                   hospital_id AS "hospitalId", blood_bank_id AS "bloodBankId",
                   donor_id AS "donorId", donor_city_code AS "donorCityCode"`,
        [
          body.username,
          body.email,
          passwordHash,
          body.role,
          body.hospitalId ?? null,
          body.bloodBankId ?? null,
          body.donorId ?? null,
          body.donorCityCode ?? null,
        ],
      );
      res.status(201).json({ user: result.rows[0] });
    } catch (error) {
      if (error.code === "23505") {
        throw new AppError(409, "ACCOUNT_ALREADY_EXISTS", "That username or email is already registered.");
      }
      throw error;
    }
  }),
);

router.delete(
  "/admin/hospitals/:entityId",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  validate(entityIdParamSchema, "params"),
  asyncRoute(async (req, res) => {
    const { entityId } = req.params;
    const catalogPool = getCatalogPool();

    const found = await catalogPool.query(
      "SELECT name, city_code FROM catalog.hospitals WHERE hospital_id = $1",
      [entityId],
    );
    if (found.rowCount === 0) {
      throw new AppError(404, "HOSPITAL_NOT_FOUND", "That hospital does not exist.");
    }
    const cityCode = found.rows[0].city_code;
    const ownSchemas = schemasFor(cityCode);

    const steps = [
      // Call-outs this hospital sent can live in ANY city shard, because a
      // request is filed in the donor's shard. Each city is its own step so a
      // failure in one node cannot leave another node half-cleaned.
      ...CITY_CODES.map((code) => ({
        name: `callouts:${code}`,
        run: () =>
          onCity(code, async (client) => {
            const captured = await captureDelete(
              client,
              reopenOn((undo) => onCity(code, undo)),
              `${schemasFor(code).hot}.donor_requests`,
              "requested_by_hospital_id = $1",
              [entityId],
            );
            return {
              count: captured.count,
              compensate: () => captured.compensate(),
            };
          }),
      })),
      {
        name: `clinical:${cityCode}`,
        run: () =>
          onCity(cityCode, async (client) => {
            const { hot, hist } = ownSchemas;
            const reopen = reopenOn((undo) => onCity(cityCode, undo));
            const unitRows = await client.query(
              `SELECT array_agg(unit_id) AS ids FROM ${hot}.blood_units
               WHERE unit_id IN (SELECT unit_id FROM ${hot}.reservations WHERE hospital_id = $1)`,
              [entityId],
            );
            const unitCascade = await purgeUnits(client, reopen, ownSchemas, unitRows.rows[0].ids ?? []);

            const transfusions = await captureDelete(client, reopen, `${hist}.transfusions`, "hospital_id = $1", [entityId]);
            const reservations = await captureDelete(client, reopen, `${hot}.reservations`, "hospital_id = $1", [entityId]);
            const processed = await captureDelete(client, reopen, `${hot}.processed_requests`, "hospital_id = $1", [entityId]);

            return {
              counts: {
                transfusions: transfusions.count,
                reservations: reservations.count,
                processedRequests: processed.count,
                ...unitCascade.counts,
              },
              // Reverse of the delete order: unit children, then processed
              // requests, then reservations, then the transfusions themselves.
              compensate: async () => {
                let restored = await unitCascade.compensate();
                restored += await processed.compensate();
                restored += await reservations.compensate();
                restored += await transfusions.compensate();
                return restored;
              },
            };
          }),
      },
      {
        name: "catalog",
        run: () =>
          onCatalog(async (client) => {
            const reopen = reopenOn(onCatalog);
            const accounts = await captureDelete(client, reopen, "catalog.users", "hospital_id = $1", [entityId]);
            const hospital = await captureDelete(client, reopen, "catalog.hospitals", "hospital_id = $1", [entityId]);
            return {
              counts: { accounts: accounts.count, accountsRemoved: accounts.rows.map((row) => row.username) },
              compensate: async () => {
                let restored = await hospital.compensate();
                restored += await accounts.compensate();
                return restored;
              },
            };
          }),
      },
    ];

    const result = await runSaga(`delete-hospital:${entityId}`, steps, sagaLog);

    const counts = {
      accounts: 0,
      accountsRemoved: [],
      donorRequests: 0,
      transfusions: 0,
      reservations: 0,
      processedRequests: 0,
      statusLog: 0,
      outbox: 0,
      readModel: 0,
    };
    for (const entry of result.results) {
      const payload = entry.value ?? {};
      if (payload.counts) Object.assign(counts, payload.counts);
      // Only the call-out steps use the flat `count` shape.
      if (typeof payload.count === "number") counts.donorRequests += payload.count;
    }

    res.json({
      deleted: true,
      entity: "hospital",
      name: found.rows[0].name,
      saga: result.steps,
      cascade: counts,
    });
  }),
);

router.delete(
  "/admin/blood-banks/:entityId",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  validate(entityIdParamSchema, "params"),
  asyncRoute(async (req, res) => {
    const { entityId } = req.params;
    const catalogPool = getCatalogPool();

    const found = await catalogPool.query(
      "SELECT name, city_code FROM catalog.blood_banks WHERE blood_bank_id = $1",
      [entityId],
    );
    if (found.rowCount === 0) {
      throw new AppError(404, "BLOOD_BANK_NOT_FOUND", "That blood bank does not exist.");
    }
    const cityCode = found.rows[0].city_code;
    const ownSchemas = schemasFor(cityCode);

    const steps = [
      ...CITY_CODES.map((code) => ({
        name: `callouts:${code}`,
        run: () =>
          onCity(code, async (client) => {
            const captured = await captureDelete(
              client,
              reopenOn((undo) => onCity(code, undo)),
              `${schemasFor(code).hot}.donor_requests`,
              "requested_by_blood_bank_id = $1",
              [entityId],
            );
            return { count: captured.count, compensate: () => captured.compensate() };
          }),
      })),
      {
        name: `inventory:${cityCode}`,
        run: () =>
          onCity(cityCode, async (client) => {
            const { hot, hist } = ownSchemas;
            const reopen = reopenOn((undo) => onCity(cityCode, undo));
            const unitRows = await client.query(
              `SELECT array_agg(unit_id) AS ids FROM ${hot}.blood_units WHERE blood_bank_id = $1`,
              [entityId],
            );
            const unitCascade = await purgeUnits(client, reopen, ownSchemas, unitRows.rows[0].ids ?? []);

            const units = await captureDelete(client, reopen, `${hot}.blood_units`, "blood_bank_id = $1", [entityId]);
            const donations = await captureDelete(client, reopen, `${hist}.donations`, "blood_bank_id = $1", [entityId]);

            return {
              counts: { bloodUnits: units.count, donations: donations.count, ...unitCascade.counts },
              compensate: async () => {
                let restored = await donations.compensate();
                restored += await units.compensate();
                restored += await unitCascade.compensate();
                return restored;
              },
            };
          }),
      },
      {
        name: "catalog",
        run: () =>
          onCatalog(async (client) => {
            const reopen = reopenOn(onCatalog);
            const accounts = await captureDelete(client, reopen, "catalog.users", "blood_bank_id = $1", [entityId]);
            const bank = await captureDelete(client, reopen, "catalog.blood_banks", "blood_bank_id = $1", [entityId]);
            return {
              counts: { accounts: accounts.count, accountsRemoved: accounts.rows.map((row) => row.username) },
              compensate: async () => {
                let restored = await bank.compensate();
                restored += await accounts.compensate();
                return restored;
              },
            };
          }),
      },
    ];

    const result = await runSaga(`delete-blood-bank:${entityId}`, steps, sagaLog);

    const counts = {
      accounts: 0,
      accountsRemoved: [],
      donorRequests: 0,
      bloodUnits: 0,
      donations: 0,
      transfusions: 0,
      reservations: 0,
      statusLog: 0,
      outbox: 0,
      readModel: 0,
    };
    for (const entry of result.results) {
      const payload = entry.value ?? {};
      if (payload.counts) Object.assign(counts, payload.counts);
      if (typeof payload.count === "number") counts.donorRequests += payload.count;
    }

    res.json({
      deleted: true,
      entity: "bloodBank",
      name: found.rows[0].name,
      saga: result.steps,
      cascade: counts,
    });
  }),
);

router.delete(
  "/admin/donors/:entityId",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  validate(entityIdParamSchema, "params"),
  asyncRoute(async (req, res) => {
    const { entityId } = req.params;
    const { city } = parseQuery(donorDeleteQuerySchema, req.query);
    const schemas = schemasFor(city);
    const { hot, hist } = schemas;

    const found = await getPoolForCity(city).query(
      `SELECT full_name FROM ${hist}.donors WHERE donor_id = $1`,
      [entityId],
    );
    if (found.rowCount === 0) {
      throw new AppError(404, "DONOR_NOT_FOUND", `That donor does not exist in the ${city} shard.`);
    }

    const steps = [
      {
        // A donor lives in exactly one city shard, so unlike the hospital and
        // bank deletes this saga has a single city step plus the catalog step.
        // donor_requests carries a real foreign key to the donor, so the
        // call-outs have to go before the donor row or the delete is rejected.
        name: `donor:${city}`,
        run: () =>
          onCity(city, async (client) => {
            const reopen = reopenOn((undo) => onCity(city, undo));
            const callouts = await captureDelete(client, reopen, `${hot}.donor_requests`, "donor_id = $1", [entityId]);
            const unitRows = await client.query(
              `SELECT array_agg(unit_id) AS ids FROM ${hot}.blood_units
               WHERE donation_id IN (SELECT donation_id FROM ${hist}.donations WHERE donor_id = $1)`,
              [entityId],
            );
            const unitCascade = await purgeUnits(client, reopen, schemas, unitRows.rows[0].ids ?? []);

            const units = await captureDelete(
              client,
              reopen,
              `${hot}.blood_units`,
              "donation_id IN (SELECT donation_id FROM " + hist + ".donations WHERE donor_id = $1)",
              [entityId],
            );
            const donations = await captureDelete(client, reopen, `${hist}.donations`, "donor_id = $1", [entityId]);
            const donor = await captureDelete(client, reopen, `${hist}.donors`, "donor_id = $1", [entityId]);

            return {
              counts: {
                donorRequests: callouts.count,
                bloodUnits: units.count,
                donations: donations.count,
                ...unitCascade.counts,
              },
              // Undo runs in the exact reverse of the delete order, and every
              // compensation opens its own transaction, so the donor row is back
              // before the donations and call-outs that reference it.
              compensate: async () => {
                let restored = await donor.compensate();
                restored += await donations.compensate();
                restored += await units.compensate();
                restored += await unitCascade.compensate();
                restored += await callouts.compensate();
                return restored;
              },
            };
          }),
      },
      {
        name: "catalog",
        run: () =>
          onCatalog(async (client) => {
            const reopen = reopenOn(onCatalog);
            const accounts = await captureDelete(client, reopen, "catalog.users", "donor_id = $1", [entityId]);
            return {
              counts: { accounts: accounts.count, accountsRemoved: accounts.rows.map((row) => row.username) },
              compensate: () => accounts.compensate(),
            };
          }),
      },
    ];

    const result = await runSaga(`delete-donor:${entityId}`, steps, sagaLog);

    const counts = {
      accounts: 0,
      accountsRemoved: [],
      donorRequests: 0,
      bloodUnits: 0,
      donations: 0,
      transfusions: 0,
      reservations: 0,
      statusLog: 0,
      outbox: 0,
      readModel: 0,
    };
    for (const entry of result.results) {
      if (entry.value?.counts) Object.assign(counts, entry.value.counts);
    }

    res.json({
      deleted: true,
      entity: "donor",
      name: found.rows[0].full_name,
      cityCode: city,
      saga: result.steps,
      cascade: counts,
    });
  }),
);

export default router;