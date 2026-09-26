import { getCatalogPool } from "../db/registry.js";
import { AppError } from "../middleware/errors.js";

export async function getActiveBank(bloodBankId) {
  const result = await getCatalogPool().query(
    `SELECT blood_bank_id, name, city_code, is_active
     FROM catalog.blood_banks WHERE blood_bank_id = $1`,
    [bloodBankId],
  );
  const bank = result.rows[0];
  if (!bank?.is_active) throw new AppError(404, "BLOOD_BANK_NOT_FOUND", "The blood bank was not found or is inactive.");
  return bank;
}

export async function getActiveHospital(hospitalId) {
  const result = await getCatalogPool().query(
    `SELECT hospital_id, name, city_code, is_active
     FROM catalog.hospitals WHERE hospital_id = $1`,
    [hospitalId],
  );
  const hospital = result.rows[0];
  if (!hospital?.is_active) throw new AppError(404, "HOSPITAL_NOT_FOUND", "The hospital was not found or is inactive.");
  return hospital;
}