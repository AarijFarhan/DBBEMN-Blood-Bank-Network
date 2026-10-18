import { useEffect, useRef, useState } from "react";
import { getSession } from "../api";

const MAX_FEED_ITEMS = 60;

/**
 * Live SSE feed.
 *
 * `EventSource` cannot attach an Authorization header, so the access token
 * travels as a query parameter — the server verifies it with the exact same
 * checks as the REST middleware (signature, issuer, revocation, active
 * account), so the stream is never a weaker door in. The native reconnect
 * behaviour of EventSource is relied on: the browser retries with
 * `Last-Event-ID`, and the server replays what was missed from its ring
 * buffer.
 */
export function useEventStream({ enabled = true } = {}) {
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const token = getSession()?.accessToken;
    if (!token) return undefined;

    const base = (import.meta.env.VITE_API_URL ?? "").trim().replace(/\/+$/, "");
    const root = base
      ? (base.endsWith("/api/v1") ? base : `${base}/api/v1`)
      : (import.meta.env.DEV ? "/api/v1" : "https://dbbemn-blood-bank-network.onrender.com/api/v1");
    const source = new EventSource(`${root}/events/stream?access_token=${encodeURIComponent(token)}`);
    sourceRef.current = source;

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    const handle = (event) => {
      try {
        const payload = JSON.parse(event.data);
        setEvents((current) => {
          const next = [...current, payload];
          return next.length > MAX_FEED_ITEMS ? next.slice(next.length - MAX_FEED_ITEMS) : next;
        });
      } catch {
        // A malformed frame must not kill the stream; the next event still lands.
      }
    };

    // The server dispatches with a typed `event:` field, so a wildcard
    // listener is not available on EventSource. Subscribe to the known types
    // explicitly, plus the unnamed default.
    const types = [
      "reservation.created",
      "reservation.updated",
      "unit.updated",
      "donation.created",
      "donation.screening",
      "maintenance.sweep",
      "chaos.changed",
      "inventory.changed",
      "message",
    ];
    types.forEach((type) => source.addEventListener(type, handle));

    return () => {
      types.forEach((type) => source.removeEventListener(type, handle));
      source.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, [enabled]);

  return { events, connected, clear: () => setEvents([]) };
}
