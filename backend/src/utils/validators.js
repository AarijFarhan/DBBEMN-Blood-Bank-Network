import { z } from "zod";
import { CITY_CODES } from "../db/shard-router.js";

export const cityCodeSchema = z.enum(CITY_CODES);
export const bloodGroupSchema = z.enum(["A", "B", "AB", "O"]);
export const rhSchema = z.enum(["POS", "NEG"]);
export const componentSchema = z.enum(["WHOLE_BLOOD", "PRBC", "PLATELETS", "PLASMA"]);
export const urgencySchema = z.enum(["CRITICAL", "URGENT", "ROUTINE"]);
export const uuidSchema = z.string().uuid();
export const passwordSchema = z.string()
  .min(12)
  .max(72)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password must be at most 72 UTF-8 bytes.");

export const registerDonorSchema = z.object({
  username: z.string().trim().min(3).max(50),
  email: z.string().trim().email().max(254),
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(5).max(30),
  dateOfBirth: z.string().date(),
  sex: z.enum(["M", "F"]),
  weightKg: z.number().positive().max(400),
  bloodGroup: bloodGroupSchema,
  rhFactor: rhSchema,
  cityCode: cityCodeSchema,
});

export const loginSchema = z.object({
  login: z.string().trim().min(1).max(254),
  password: passwordSchema,
});

export const refreshSchema = z.object({ refreshToken: z.string().min(1) });

export const catalogEntitySchema = z.object({
  name: z.string().trim().min(2).max(160),
  cityCode: cityCodeSchema,
  address: z.string().trim().max(500).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
});

export const createUserSchema = z.object({
  username: z.string().trim().min(3).max(50),
  email: z.string().trim().email().max(254),
  password: passwordSchema,
  role: z.enum(["SYSTEM_ADMIN", "HOSPITAL_ADMIN", "BLOODBANK_ADMIN", "DONOR"]),
  hospitalId: uuidSchema.optional(),
  bloodBankId: uuidSchema.optional(),
  donorId: uuidSchema.optional(),
  donorCityCode: cityCodeSchema.optional(),
});

export function queryObject(searchParams) {
  return Object.fromEntries(searchParams.entries());
}