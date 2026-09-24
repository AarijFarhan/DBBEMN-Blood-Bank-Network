import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { schemasFor } from "../db/shard-router.js";
import { pool } from "../db/pool.js";
import { authenticate, requireRole } from "../middleware/auth.js";
import { AppError, asyncRoute } from "../middleware/errors.js";
import { parseQuery } from "../middleware/validate.js";
import { validate } from "../middleware/validate.js";
import { catalogEntitySchema, cityCodeSchema, createUserSchema } from "../utils/validators.js";

const router = Router();
const cityQuerySchema = z.object({ city: cityCodeSchema.optional() });

router.get(
  "/cities",
  asyncRoute(async (_req, res) => {
    const result = await pool.query(
      `SELECT city_code AS "cityCode", name, latitude, longitude
       FROM catalog.cities ORDER BY name`,
    );
    res.json({ cities: result.rows });
  }),
);

router.get(
  "/hospitals",
  asyncRoute(async (req, res) => {
    const { city } = parseQuery(cityQuerySchema, req.query);
    const result = await pool.query(
      `SELECT hospital_id AS "hospitalId", name, city_code AS "cityCode",
              address, latitude, longitude, phone
       FROM catalog.hospitals
       WHERE is_active AND ($1::char(3) IS NULL OR city_code = $1)
       ORDER BY city_code, name`,
      [city ?? null],
    );
    res.json({ hospitals: result.rows });
  }),
);

router.get(
  "/blood-banks",
  asyncRoute(async (req, res) => {
    const { city } = parseQuery(cityQuerySchema, req.query);
    const result = await pool.query(
      `SELECT blood_bank_id AS "bloodBankId", name, city_code AS "cityCode",
              address, latitude, longitude, phone
       FROM catalog.blood_banks
       WHERE is_active AND ($1::char(3) IS NULL OR city_code = $1)
       ORDER BY city_code, name`,
      [city ?? null],
    );
    res.json({ bloodBanks: result.rows });
  }),
);

router.post(
  "/admin/hospitals",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  validate(catalogEntitySchema),
  asyncRoute(async (req, res) => {
    const body = req.body;
    const result = await pool.query(
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
    res.status(201).json({ hospital: result.rows[0] });
  }),
);

router.post(
  "/admin/blood-banks",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  validate(catalogEntitySchema),
  asyncRoute(async (req, res) => {
    const body = req.body;
    const result = await pool.query(
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
    res.status(201).json({ bloodBank: result.rows[0] });
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
      const exists = await pool.query(
        "SELECT 1 FROM catalog.hospitals WHERE hospital_id = $1 AND is_active",
        [body.hospitalId],
      );
      if (exists.rowCount === 0) throw new AppError(422, "INVALID_HOSPITAL", "The hospital does not exist or is inactive.");
    }
    if (body.role === "BLOODBANK_ADMIN") {
      const exists = await pool.query(
        "SELECT 1 FROM catalog.blood_banks WHERE blood_bank_id = $1 AND is_active",
        [body.bloodBankId],
      );
      if (exists.rowCount === 0) throw new AppError(422, "INVALID_BLOOD_BANK", "The blood bank does not exist or is inactive.");
    }
    if (body.role === "DONOR") {
      const { hist } = schemasFor(body.donorCityCode);
      const donor = await pool.query(
        `SELECT 1 FROM ${hist}.donors WHERE donor_id = $1`,
        [body.donorId],
      );
      if (donor.rowCount === 0) throw new AppError(422, "INVALID_DONOR", "The donor does not exist in that city.");
    }

    const passwordHash = await bcrypt.hash(body.password, 12);
    try {
      const result = await pool.query(
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

export default router;