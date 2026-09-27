/**
 * Access-token revocation list.
 *
 * JWTs are self-contained, so verifying the signature is not enough to know
 * whether a token has since been logged out. Revoking by *identifier* keeps the
 * stateless property — no token lookup on the hot path — while still allowing
 * instant invalidation.
 *
 * Entries expire with the token they name, so the list cannot grow without bound:
 * a 15-minute access token adds at most 15 minutes of TTL.
 */
import { cacheGet, cacheSet, isSharedCache } from "./store.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ module: "token-blacklist" });

function entryKey(jti, expiresAtSeconds) {
  return `revoked:access:${jti}`;
}

/**
 * Revoke an access token until it would have expired anyway.
 *
 * Silently does nothing when the token has no jti (issued before revocation
 * existed) or is already expired, because in both cases revoking achieves
 * nothing that time does not achieve on its own.
 */
export async function revokeAccessToken(jti, expiresAtSeconds) {
  if (!jti || !Number.isFinite(Number(expiresAtSeconds))) return false;
  const ttl = Math.floor(Number(expiresAtSeconds) - Date.now() / 1000);
  if (ttl <= 0) return false;
  try {
    // TTL equals the token's remaining life, so the list is self-cleaning: an
    // entry can never outlive the token it names.
    await cacheSet(entryKey(jti, expiresAtSeconds), "1", ttl);
  } catch (error) {
    log.warn({ err: error.message }, "failed to record token revocation");
    return false;
  }
  return true;
}

/**
 * Is this access token currently revoked?
 *
 * Fails **open** on a cache error. A revoked token that slips through is a
 * narrower exposure than an outage that locks every user out of the API, and the
 * window is bounded by the token's remaining lifetime.
 */
export async function isAccessTokenRevoked(jti, expiresAtSeconds) {
  if (!jti) return false;
  if (!Number.isFinite(Number(expiresAtSeconds))) return false;
  if (Number(expiresAtSeconds) * 1000 <= Date.now()) return false;
  try {
    return (await cacheGet(entryKey(jti, expiresAtSeconds))) === "1";
  } catch (error) {
    log.warn({ err: error.message }, "revocation check failed; allowing request");
    return false;
  }
}

/**
 * Whether revocations are visible across instances. Without a shared cache a
 * logout only revokes on the instance that served it, so the caller can warn.
 */
export function revocationIsShared() {
  return isSharedCache();
}
