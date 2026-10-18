/**
 * Server-sent events for the live operations feed.
 *
 * `GET /events/stream` holds the connection open and forwards every bus event
 * as an SSE frame. Clients reconnect natively (`EventSource` retries), and the
 * `Last-Event-ID` header lets a reconnecting stream replay what it missed from
 * the ring buffer instead of going blind until the next mutation.
 *
 * Why SSE and not WebSocket: the feed is one-directional (server to browser).
 * SSE rides on plain HTTP, so it survives the same proxies, CORS rules, and
 * auth middleware as every other route — no second protocol to configure, and
 * the existing bearer-token flow is reused as-is via `?access_token=`, since
 * `EventSource` cannot set request headers.
 */
import { Router } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { getCatalogPool } from "../db/registry.js";
import { isAccessTokenRevoked } from "../cache/revocations.js";
import { asyncRoute } from "../middleware/errors.js";
import { currentSequence, recentEvents, subscribe } from "../lib/bus.js";
import { logger } from "../lib/logger.js";

const router = Router();
const log = logger.child({ module: "events" });
const HEARTBEAT_MS = 25_000;

/**
 * Authenticate an SSE connection.
 *
 * `EventSource` cannot attach an Authorization header, so the access token
 * arrives as a query parameter. It is verified with the exact same checks as
 * the middleware (signature, issuer, audience, revocation, active account) so
 * the stream is never a weaker door into the system than the REST API.
 */
async function authenticateStream(token) {
  if (!token) return null;
  let claims;
  try {
    claims = jwt.verify(token, env.jwtSecret, { issuer: "dbbemn", audience: "dbbemn-api" });
  } catch {
    return null;
  }
  if (!claims?.sub || !claims?.role) return null;
  if (await isAccessTokenRevoked(claims.jti, claims.exp)) return null;
  const user = await getCatalogPool().query(
    `SELECT user_id, role, hospital_id, blood_bank_id, is_active
     FROM catalog.users WHERE user_id = $1`,
    [claims.sub],
  );
  const row = user.rows[0];
  if (!row?.is_active) return null;
  return row;
}

/**
 * Role-based event filter.
 *
 * A donor's stream only carries events about their own requests; a blood bank
 * sees its own city's inventory churn; the system admin sees everything. This
 * keeps a live feed from leaking other tenants' activity to a connected
 * browser, which matters because the stream outlives any single request.
 */
function eventVisibleTo(user, event) {
  if (user.role === "SYSTEM_ADMIN") return true;
  if (user.role === "DONOR") {
    return event.type.startsWith("donorRequest.")
      || (event.payload?.donorId && event.payload.donorId === user.donor_id);
  }
  if (user.role === "BLOODBANK_ADMIN") {
    if (event.payload?.bloodBankId) return event.payload.bloodBankId === user.blood_bank_id;
    if (event.payload?.cityCode) return true;
    return true;
  }
  if (user.role === "HOSPITAL_ADMIN") {
    if (event.payload?.hospitalId) return event.payload.hospitalId === user.hospital_id;
    return true;
  }
  return false;
}

function formatFrame(event) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

router.get(
  "/events/stream",
  asyncRoute(async (req, res) => {
    const token = req.get("authorization")?.startsWith("Bearer ")
      ? req.get("authorization").slice(7)
      : (req.query.access_token ?? null);
    const user = await authenticateStream(token);
    if (!user) {
      res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "A valid access token is required for the event stream.", details: null },
      });
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const clientId = `${user.user_id}:${Date.now()}`;
    log.info({ clientId, role: user.role }, "SSE stream opened");

    // Replay anything the client missed while disconnected, so a reload does
    // not open the feed on a blank screen until the next mutation lands.
    const lastEventId = Number(req.get("last-event-id") ?? req.query.lastEventId ?? 0);
    if (Number.isFinite(lastEventId) && lastEventId > 0) {
      const missed = recentEvents().filter((event) => event.id > lastEventId && eventVisibleTo(user, event));
      for (const event of missed) res.write(formatFrame(event));
    } else {
      // First connect: a short preview of recent activity, so the feed panel
      // is never empty on a cold dashboard.
      const preview = recentEvents(10).filter((event) => eventVisibleTo(user, event));
      for (const event of preview) res.write(formatFrame(event));
    }
    res.write(`retry: 3000\n\n`);

    const unsubscribe = subscribe((event) => {
      if (!eventVisibleTo(user, event)) return;
      if (res.writableEnded) return;
      res.write(formatFrame(event));
    });

    // Heartbeat keeps proxies and load balancers from reaping an idle stream.
    // The comment frame is invisible to EventSource consumers but resets idle
    // timers on every hop between the API and the browser.
    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      res.write(`: ping ${Date.now()}\n\n`);
    }, HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      log.info({ clientId }, "SSE stream closed");
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }),
);

export default router;
