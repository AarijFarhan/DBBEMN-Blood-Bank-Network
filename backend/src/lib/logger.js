import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "password",
      "password_hash",
      "token",
      "token_hash",
      "accessToken",
      "refreshToken",
      "jwtSecret",
      "jwtRefreshSecret",
    ],
    censor: "[REDACTED]",
  },
});