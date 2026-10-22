/**
 * Event bus for the live operations feed.
 *
 * Every committed mutation that changes what the network can see — a
 * reservation, a screening result, a discard, an expiry sweep, a chaos flag
 * flip — publishes one event here. The SSE route (`routes/events.js`) turns
 * subscribers into HTTP streams; the dashboard consumes those streams.
 *
 * The bus fans out over Redis Pub/Sub when Redis is configured, so an event
 * published by one instance reaches the dashboards connected to the others.
 * That used to be per-process only, which meant a mutation made on one
 * instance was invisible to a client watching another — the split-brain the
 * shared cache was meant to remove.
 *
 * Without Redis the bus stays in-process, exactly as it was: a single
 * instance is unaffected by the change, and a multi-instance deploy without
 * Redis is no worse than before.
 *
 * A ring buffer of recent events lets a client that connects a moment after a
 * mutation still see it, which is what keeps a dashboard from feeling "stale
 * until the next click".
 */
import { EventEmitter } from "node:events";
import { isSharedReady, sharedPublish, sharedSubscribe } from "../cache/shared.js";

const HISTORY_LIMIT = 50;
const history = [];
let sequence = 0;

/** Channel the bus publishes on. */
const EVENT_CHANNEL = "events";

/** Which instance published an event. Used to ignore our own echo. */
const instanceId = process.env.INSTANCE_ID || "local";

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
 * Hand an event to the local subscribers and the ring buffer.
 *
 * Listeners are called individually rather than via `hub.emit`, because emit
 * stops at the first listener that throws. A broken subscriber (for example a
 * closed HTTP stream mid-write) must never fail the mutation that published
 * the event, nor starve the other live clients of an event they never saw.
 * `listeners()` returns a snapshot, so a listener that unsubscribes itself
 * mid-iteration cannot corrupt the loop either.
 */
function deliver(event) {
  history.push(event);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  for (const listener of hub.listeners("event")) {
    try {
      listener(event);
    } catch {
      // Already in the ring buffer, so every other client still receives it,
      // and the publisher path is untouched.
    }
  }
}

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
    instance: instanceId,
    payload,
  };
  deliver(event);
  // Fan out to the other instances. Deliberately not awaited: a slow or
  // missing Redis must not delay the mutation that produced the event.
  if (isSharedReady()) void sharedPublish(EVENT_CHANNEL, event);
  return event;
}

/**
 * Start receiving events published by the other instances.
 *
 * Returns false when there is nothing to subscribe to, which is the
 * single-instance case.
 */
export function initEventBus() {
  if (!isSharedReady()) return false;
  return sharedSubscribe(EVENT_CHANNEL, (event) => {
    // Our own event comes back through the channel; it was already delivered
    // locally, and delivering it twice would show up as a duplicate row.
    if (!event || event.instance === instanceId) return;
    // The id space is per instance, so a remote event is renumbered here. A
    // client's Last-Event-ID is a position in the stream it is reading, not a
    // position in the publisher's stream.
    sequence += 1;
    deliver({ ...event, id: sequence });
  });
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
