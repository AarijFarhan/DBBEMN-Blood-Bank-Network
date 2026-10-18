/**
 * In-process event bus for the live operations feed.
 *
 * Every committed mutation that changes what the network can see — a
 * reservation, a screening result, a discard, an expiry sweep, a chaos flag
 * flip — publishes one event here. The SSE route (`routes/events.js`) turns
 * subscribers into HTTP streams; the dashboard consumes those streams.
 *
 * Deliberately in-process, like the in-memory cache fallback and the circuit
 * breakers. On a multi-instance deploy each instance only sees its own writes,
 * which is stated honestly in the README rather than papered over with a
 * pretend-distributed broker. The `X-Instance-Id` header and the `instance`
 * field on every event make that boundary visible to the client.
 *
 * A ring buffer of recent events lets a client that connects a moment after a
 * mutation still see it, which is what keeps a dashboard from feeling "stale
 * until the next click".
 */
import { EventEmitter } from "node:events";

const HISTORY_LIMIT = 50;
const history = [];
let sequence = 0;

class EventHub extends EventEmitter {}

const hub = new EventHub();
// Many SSE clients, one emitter. The default limit of 10 would silently drop
// the 11th subscriber, which fails exactly when a demo has an audience.
hub.setMaxListeners(0);

export const EVENT_TYPES = Object.freeze({
  RESERVATION_CREATED: "reservation.created",
  RESERVATION_UPDATED: "reservation.updated",
  UNIT_UPDATED: "unit.updated",
  DONATION_CREATED: "donation.created",
  SCREENING_COMPLETED: "donation.screening",
  SWEEP_COMPLETED: "maintenance.sweep",
  CHAOS_FLAG_CHANGED: "chaos.changed",
  INVENTORY_CHANGED: "inventory.changed",
});

/**
 * Publish an event. Payloads are kept small: SSE frames travel to every open
 * stream, so a fat payload multiplies across clients.
 */
export function publish(type, payload = {}) {
  sequence += 1;
  const event = {
    id: sequence,
    type,
    at: new Date().toISOString(),
    instance: process.env.INSTANCE_ID || "local",
    payload,
  };
  history.push(event);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  // Listeners are called individually rather than via `hub.emit`, because emit
  // stops at the first listener that throws. A broken subscriber (for example a
  // closed HTTP stream mid-write) must never fail the mutation that published
  // the event, nor starve the other live clients of an event they never saw.
  // `listeners()` returns a snapshot, so a listener that unsubscribes itself
  // mid-iteration cannot corrupt the loop either.
  for (const listener of hub.listeners("event")) {
    try {
      listener(event);
    } catch {
      // Already in the ring buffer, so every other client still receives it,
      // and the publisher path is untouched.
    }
  }
  return event;
}

/** Recent events, newest last. Used to prime a stream that just connected. */
export function recentEvents(limit = HISTORY_LIMIT) {
  return history.slice(Math.max(0, history.length - limit));
}

/** Current sequence number, so a client can detect missed events. */
export function currentSequence() {
  return sequence;
}

export function subscribe(listener) {
  hub.on("event", listener);
  return () => hub.off("event", listener);
}
