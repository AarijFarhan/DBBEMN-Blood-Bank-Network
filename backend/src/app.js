import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { AppError, errorHandler, notFoundHandler } from "./middleware/errors.js";
import authRoutes from "./routes/auth.js";
import catalogRoutes from "./routes/catalog.js";
import chaosRoutes from "./routes/chaos.js";
import donationRoutes from "./routes/donations.js";
import donorRoutes from "./routes/donors.js";
import donorRequestRoutes from "./routes/donor-requests.js";
import healthRoutes from "./routes/health.js";
import reservationRoutes from "./routes/reservations.js";
import searchRoutes from "./routes/search.js";
import unitRoutes from "./routes/units.js";

const app = express();
const frontendDir = fileURLToPath(env.frontendDist);
const frontendIndex = `${frontendDir.replace(/\/$/, "")}/index.html`;

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.locals.instanceId = env.instanceId;
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
}));
app.use((req, res, next) => {
  res.setHeader("X-Instance-Id", env.instanceId);
  req.log = logger.child({ requestId: req.get("x-request-id") || undefined });
  const origin = req.get("origin");
  if (!origin || env.corsOrigins.includes(origin) || origin === `${req.protocol}://${req.get("host")}`) {
    cors({ origin: origin || false })(req, res, next);
    return;
  }
  next(new AppError(403, "CORS_ORIGIN_DENIED", "This origin is not allowed."));
});
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many authentication requests. Try again later.",
        details: null,
      },
    });
  },
});
app.use("/api/v1/auth", authLimiter);
app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));
app.use("/api/v1", healthRoutes);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1", catalogRoutes);
app.use("/api/v1", searchRoutes);
app.use("/api/v1", chaosRoutes);
app.use("/api/v1", donorRoutes);
app.use("/api/v1", donorRequestRoutes);
app.use("/api/v1", donationRoutes);
app.use("/api/v1", unitRoutes);
app.use("/api/v1", reservationRoutes);

if (existsSync(frontendDir)) {
  app.use("/api", express.static(frontendDir, { index: "index.html", fallthrough: true }));
  app.get(/^\/api\/(?!v1(?:\/|$)|healthz(?:\/|$)).*/, (_req, res, next) => {
    if (existsSync(frontendIndex)) {
      res.sendFile(frontendIndex, (error) => {
        if (error) next(error);
      });
      return;
    }
    next();
  });
}

app.use(notFoundHandler);
app.use(errorHandler);

export default app;