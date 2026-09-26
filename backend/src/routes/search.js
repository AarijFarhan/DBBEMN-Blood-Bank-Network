import { Router } from "express";
import { z } from "zod";
import { CITY_CODES } from "../db/shard-router.js";
import { authenticate, requireRole } from "../middleware/auth.js";
import { AppError, asyncRoute } from "../middleware/errors.js";
import { parseQuery } from "../middleware/validate.js";
import { getActiveBank } from "../services/catalog.js";
import { searchUnits, stockSummary } from "../services/search.js";
import {
  bloodGroupSchema,
  cityCodeSchema,
  componentSchema,
  rhSchema,
  uuidSchema,
} from "../utils/validators.js";

const router = Router();
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)),
  "Date must be a valid ISO date.",
);
const compatibleWithSchema = z.string().trim().regex(/^(A|B|AB|O)(POS|NEG|\+|-)$/);
const cityListSchema = z.preprocess((value) => {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => typeof item === "string" ? item.split(",") : [item]).filter((item) => item !== "");
}, z.array(cityCodeSchema).min(1).max(CITY_CODES.length).optional());

const searchQuerySchema = z.object({
  bloodGroup: bloodGroupSchema.optional(),
  rh: rhSchema.optional(),
  component: componentSchema.optional(),
  city: cityListSchema,
  expiresBefore: isoDateSchema.optional(),
  expiresAfter: isoDateSchema.optional(),
  minVolumeMl: z.coerce.number().int().min(1).max(1_000).optional(),
  bankId: uuidSchema.optional(),
  compatibleWith: compatibleWithSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  fromHospitalId: uuidSchema.optional(),
  sortBy: z.enum(["expiryDate", "volumeMl", "collectedOn", "bloodGroup", "distance"]).default("expiryDate"),
  order: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(2_000).optional(),
}).superRefine((value, context) => {
  if (value.expiresBefore && value.expiresAfter && value.expiresBefore < value.expiresAfter) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresBefore"], message: "expiresBefore must not precede expiresAfter." });
  }
  if (value.sortBy === "distance" && !value.fromHospitalId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fromHospitalId"], message: "fromHospitalId is required for distance sorting." });
  }
});

const summaryQuerySchema = z.object({
  bloodGroup: bloodGroupSchema.optional(),
  rh: rhSchema.optional(),
  component: componentSchema.optional(),
  city: cityListSchema,
  expiresBefore: isoDateSchema.optional(),
  expiresAfter: isoDateSchema.optional(),
  minVolumeMl: z.coerce.number().int().min(1).max(1_000).optional(),
  bankId: uuidSchema.optional(),
  compatibleWith: compatibleWithSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

async function scopedQuery(req, query) {
  const scoped = { ...query };
  if (req.user.role === "BLOODBANK_ADMIN") {
    const bank = await getActiveBank(req.user.blood_bank_id);
    const cityCode = bank.city_code.trim();
    if (query.city && !query.city.includes(cityCode)) {
      throw new AppError(403, "TENANT_SCOPE_VIOLATION", "A blood bank can only search its own city.");
    }
    if (query.bankId && query.bankId !== req.user.blood_bank_id) {
      throw new AppError(403, "TENANT_SCOPE_VIOLATION", "A blood bank can only search its own inventory.");
    }
    scoped.city = [cityCode];
    scoped.bankId = req.user.blood_bank_id;
  }
  if (req.user.role === "HOSPITAL_ADMIN" && query.fromHospitalId && query.fromHospitalId !== req.user.hospital_id) {
    throw new AppError(403, "TENANT_SCOPE_VIOLATION", "A hospital can only use its own hospital for distance sorting.");
  }
  return scoped;
}

router.get(
  "/search/units",
  authenticate,
  requireRole("HOSPITAL_ADMIN", "BLOODBANK_ADMIN", "SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => {
    const query = await scopedQuery(req, parseQuery(searchQuerySchema, req.query));
    res.json(await searchUnits(query));
  }),
);

router.get(
  "/stock/summary",
  authenticate,
  requireRole("HOSPITAL_ADMIN", "BLOODBANK_ADMIN", "SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => {
    const query = await scopedQuery(req, parseQuery(summaryQuerySchema, req.query));
    res.json(await stockSummary(query));
  }),
);

export default router;
