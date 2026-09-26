import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../middleware/auth.js";
import { AppError, asyncRoute } from "../middleware/errors.js";
import { setChaosFlag } from "../services/chaos.js";
import { cityCodeSchema } from "../utils/validators.js";

const router = Router();
const lagSchema = z.object({ ms: z.coerce.number().int().min(0).max(86_400_000) });

function parseCity(value) {
  const result = cityCodeSchema.safeParse(value);
  if (!result.success) throw new AppError(422, "VALIDATION_ERROR", "City must be KHI, LHE, or ISB.");
  return result.data;
}

function response(flag) {
  return {
    chaos: {
      cityCode: flag.cityCode,
      primaryDown: flag.primaryDown,
      replicaDown: flag.replicaDown,
      extraLagMs: flag.extraLagMs,
      updatedAt: flag.updatedAt,
    },
    simulation: "SIMULATED",
  };
}

async function changeFlag(req, patch) {
  const cityCode = parseCity(req.params.city);
  return response(await setChaosFlag(cityCode, patch));
}

router.post(
  "/admin/chaos/:city/primary-down",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => res.json(await changeFlag(req, { primaryDown: true }))),
);

router.post(
  "/admin/chaos/:city/primary-up",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => res.json(await changeFlag(req, { primaryDown: false }))),
);

router.post(
  "/admin/chaos/:city/replica-down",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => res.json(await changeFlag(req, { replicaDown: true }))),
);

router.post(
  "/admin/chaos/:city/replica-up",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => res.json(await changeFlag(req, { replicaDown: false }))),
);

router.post(
  "/admin/chaos/:city/lag",
  authenticate,
  requireRole("SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => {
    const body = lagSchema.safeParse(req.body);
    if (!body.success) throw new AppError(422, "VALIDATION_ERROR", "ms must be an integer between 0 and 86400000.");
    return res.json(await changeFlag(req, { extraLagMs: body.data.ms }));
  }),
);

export default router;
