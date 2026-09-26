import { Router } from "express";
import { z } from "zod";
import { CITY_CODES, schemasFor } from "../db/shard-router.js";
import { withSerializableRetryFor } from "../db/pool.js";
import { getCatalogPool, getPoolForCity } from "../db/registry.js";
import { authenticate, requireRole } from "../middleware/auth.js";
import { AppError, asyncRoute } from "../middleware/errors.js";
import { parseQuery, validate } from "../middleware/validate.js";
import { getActiveBank, getActiveHospital } from "../services/catalog.js";
import { assertCityWritable } from "../services/chaos.js";
import {
  createDonorRequestSchema,
  donorRequestIdParamSchema,
  donorRequestQuerySchema,
  respondDonorRequestSchema,
} from "../utils/validators.js";

const router = Router();

const REQUEST_COLUMNS = `
  r.request_id AS "requestId",
  r.donor_id AS "donorId",
  r.requested_by_hospital_id AS "requestedByHospitalId",
  r.requested_by_blood_bank_id AS "requestedByBloodBankId",
  r.patient_ref AS "patientRef",
  r.required_blood_group AS "requiredBloodGroup",
  r.required_rh AS "requiredRh",
  r.urgency,
  r.slots_requested AS "slotsRequested",
  r.notes,
  r.status,
  r.requested_at AS "requestedAt",
  r.responded_at AS "respondedAt",
  r.response_notes AS "responseNotes",
  d.full_name AS "donorName",
  d.phone AS "donorPhone",
  d.blood_group AS "donorBloodGroup",
  d.rh_factor AS "donorRhFactor",
  d.city_code AS "donorCityCode"`;

/**
 * Attach issuer display names from the catalog node.
 *
 * Why a second pass: donor_requests lives on a city node but catalog.hospitals
 * and catalog.blood_banks live on the catalog node, so a single SQL statement
 * cannot join them once the nodes are physically separate. The shard query
 * returns the issuer ids; the names are resolved here in one batched lookup.
 */
async function attachIssuerNames(rows) {
  const hospitalIds = [...new Set(rows.map((row) => row.requestedByHospitalId).filter(Boolean))];
  const bankIds = [...new Set(rows.map((row) => row.requestedByBloodBankId).filter(Boolean))];
  if (hospitalIds.length === 0 && bankIds.length === 0) return rows;

  const catalog = getCatalogPool();
  const [hospitals, banks] = await Promise.all([
    hospitalIds.length === 0
      ? []
      : catalog
          .query(`SELECT hospital_id, name FROM catalog.hospitals WHERE hospital_id = ANY($1::uuid[])`, [hospitalIds])
          .then((result) => new Map(result.rows.map((row) => [row.hospital_id, row.name]))),
    bankIds.length === 0
      ? []
      : catalog
          .query(`SELECT blood_bank_id, name FROM catalog.blood_banks WHERE blood_bank_id = ANY($1::uuid[])`, [bankIds])
          .then((result) => new Map(result.rows.map((row) => [row.blood_bank_id, row.name]))),
  ]);

  const hospitalNames = hospitals.length === 0 ? new Map() : hospitals;
  const bankNames = banks.length === 0 ? new Map() : banks;

  for (const row of rows) {
    row.hospitalName = row.requestedByHospitalId ? hospitalNames.get(row.requestedByHospitalId) ?? null : null;
    row.bloodBankName = row.requestedByBloodBankId ? bankNames.get(row.requestedByBloodBankId) ?? null : null;
  }
  return rows;
}

/**
 * Which city shards a caller's own requests can live in.
 * Why: a request is filed in the DONOR's shard, so a requester has to look
 * across every shard to see what it sent, while a donor only ever looks at
 * the single shard that owns its profile.
 */
async function requesterScope(req) {
  if (req.user.role === "DONOR") {
    return { cities: [req.user.donor_city_code], column: "donor_id", value: req.user.donor_id };
  }
  if (req.user.role === "HOSPITAL_ADMIN") {
    return { cities: CITY_CODES, column: "requested_by_hospital_id", value: req.user.hospital_id };
  }
  if (req.user.role === "BLOODBANK_ADMIN") {
    return { cities: CITY_CODES, column: "requested_by_blood_bank_id", value: req.user.blood_bank_id };
  }
  return { cities: CITY_CODES, column: null, value: null };
}

router.get(
  "/donor-requests",
  authenticate,
  requireRole("DONOR", "HOSPITAL_ADMIN", "BLOODBANK_ADMIN", "SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => {
    const query = parseQuery(donorRequestQuerySchema, req.query);
    const scope = await requesterScope(req);
    const cities = query.city ? [query.city] : scope.cities;

    const results = await Promise.all(
      cities.map(async (cityCode) => {
        const { hot, hist } = schemasFor(cityCode);
        const values = [scope.value, query.status ?? null, query.limit];
        const issuerFilter = scope.column
          ? `r.${scope.column} = $1`
          : `($1::uuid IS NULL OR r.requested_by_hospital_id = $1 OR r.requested_by_blood_bank_id = $1)`;
        const rows = await getPoolForCity(cityCode).query(
          `SELECT ${REQUEST_COLUMNS}
           FROM ${hot}.donor_requests r
           JOIN ${hist}.donors d ON d.donor_id = r.donor_id
           WHERE ${issuerFilter}
             AND ($2::common.donor_request_status_t IS NULL OR r.status = $2)
           ORDER BY r.requested_at DESC
           LIMIT $3`,
          values,
        );
        return rows.rows;
      }),
    );

    const requests = await attachIssuerNames(
      results
        .flat()
        .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt))
        .slice(0, query.limit),
    );
    res.json({
      requests,
      total: requests.length,
      byStatus: requests.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] ?? 0) + 1 }), {}),
    });
  }),
);

router.post(
  "/donor-requests",
  authenticate,
  requireRole("HOSPITAL_ADMIN", "BLOODBANK_ADMIN"),
  validate(createDonorRequestSchema),
  asyncRoute(async (req, res) => {
    const body = req.body;
    const { hot, hist } = schemasFor(body.cityCode);

    const donor = await getPoolForCity(body.cityCode).query(
      `SELECT donor_id, full_name, blood_group, rh_factor, is_available
       FROM ${hist}.donors WHERE donor_id = $1`,
      [body.donorId],
    );
    const donorRow = donor.rows[0];
    if (!donorRow) {
      throw new AppError(404, "DONOR_NOT_FOUND", `That donor does not exist in the ${body.cityCode} shard.`);
    }

    // Why: ask only for blood the donor can actually give. Reuse the same
    // compatibility matrix the unit search uses instead of duplicating it.
    const compatible = await getPoolForCity(body.cityCode).query(
      `SELECT 1 FROM common.compatible_donor($1, $2, 'WHOLE_BLOOD'::common.component_t) AS c
       WHERE c.g = $3 AND c.r = $4`,
      [body.requiredBloodGroup, body.requiredRh, donorRow.blood_group, donorRow.rh_factor],
    );
    if (compatible.rowCount === 0) {
      throw new AppError(422, "INCOMPATIBLE_DONOR", `${donorRow.full_name} is ${donorRow.blood_group}${donorRow.rh_factor === "POS" ? "+" : "-"} and cannot donate whole blood to a ${body.requiredBloodGroup}${body.requiredRh === "POS" ? "+" : "-"} request.`, {
        donorBloodGroup: donorRow.blood_group,
        donorRhFactor: donorRow.rh_factor,
      });
    }

    const issuer = req.user.role === "HOSPITAL_ADMIN"
      ? { hospital: req.user.hospital_id, bank: null }
      : { hospital: null, bank: req.user.blood_bank_id };
    if (issuer.hospital) await getActiveHospital(issuer.hospital);
    if (issuer.bank) await getActiveBank(issuer.bank);

    const result = await withSerializableRetryFor(getPoolForCity(body.cityCode))(async (client) => {
      await assertCityWritable(client, body.cityCode);
      return client.query(
        `INSERT INTO ${hot}.donor_requests
           (donor_id, requested_by_hospital_id, requested_by_blood_bank_id,
            patient_ref, required_blood_group, required_rh, urgency,
            slots_requested, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING request_id AS "requestId", status, requested_at AS "requestedAt"`,
        [
          body.donorId,
          issuer.hospital,
          issuer.bank,
          body.patientRef ?? null,
          body.requiredBloodGroup,
          body.requiredRh,
          body.urgency,
          body.slotsRequested,
          body.notes ?? null,
        ],
      );
    });

    res.status(201).json({
      request: result.rows[0],
      donor: {
        donorId: donorRow.donor_id,
        fullName: donorRow.full_name,
        bloodGroup: donorRow.blood_group,
        rhFactor: donorRow.rh_factor,
        isAvailable: donorRow.is_available,
      },
    });
  }),
);

router.patch(
  "/donor-requests/:requestId/respond",
  authenticate,
  requireRole("DONOR"),
  validate(donorRequestIdParamSchema, "params"),
  validate(respondDonorRequestSchema),
  asyncRoute(async (req, res) => {
    const { requestId } = req.params;
    const { response, responseNotes } = req.body;
    const { hot } = schemasFor(req.user.donor_city_code);

    const result = await withSerializableRetryFor(getPoolForCity(req.user.donor_city_code))(async (client) => {
      await assertCityWritable(client, req.user.donor_city_code);
      // Why: guard the status in the WHERE clause so two taps on Accept cannot
      // both succeed; the loser gets zero rows and falls through to the 409.
      return client.query(
        `UPDATE ${hot}.donor_requests
         SET status = $1, responded_at = now(), response_notes = $2
         WHERE request_id = $3
           AND donor_id = $4
           AND status = 'PENDING'
         RETURNING request_id AS "requestId", status, responded_at AS "respondedAt",
                   response_notes AS "responseNotes"`,
        [response, responseNotes ?? null, requestId, req.user.donor_id],
      );
    });

    if (result.rowCount === 0) {
      const existing = await getPoolForCity(req.user.donor_city_code).query(
        `SELECT status FROM ${hot}.donor_requests WHERE request_id = $1 AND donor_id = $2`,
        [requestId, req.user.donor_id],
      );
      if (existing.rowCount === 0) {
        throw new AppError(404, "DONOR_REQUEST_NOT_FOUND", "That request was not found.");
      }
      throw new AppError(409, "REQUEST_ALREADY_ANSWERED", `This request was already ${existing.rows[0].status.toLowerCase()}.`);
    }

    res.json({ request: result.rows[0] });
  }),
);

router.delete(
  "/donor-requests/:requestId",
  authenticate,
  requireRole("HOSPITAL_ADMIN", "BLOODBANK_ADMIN"),
  validate(donorRequestIdParamSchema, "params"),
  asyncRoute(async (req, res) => {
    const { requestId } = req.params;
    const issuerColumn = req.user.role === "HOSPITAL_ADMIN"
      ? "requested_by_hospital_id"
      : "requested_by_blood_bank_id";
    const issuerId = req.user.role === "HOSPITAL_ADMIN" ? req.user.hospital_id : req.user.blood_bank_id;

    const results = await Promise.all(
      CITY_CODES.map(async (cityCode) => {
        const { hot } = schemasFor(cityCode);
        return getPoolForCity(cityCode).query(
          `UPDATE ${hot}.donor_requests
           SET status = 'CANCELLED', responded_at = now()
           WHERE request_id = $1 AND ${issuerColumn} = $2 AND status = 'PENDING'
           RETURNING request_id AS "requestId", status`,
          [requestId, issuerId],
        );
      }),
    );
    const updated = results.flatMap((item) => item.rows);
    if (updated.length === 0) {
      throw new AppError(404, "DONOR_REQUEST_NOT_FOUND", "No pending request with that ID was found for you.");
    }
    res.json({ request: updated[0] });
  }),
);

export default router;
