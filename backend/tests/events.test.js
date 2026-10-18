import assert from "node:assert/strict";
import { test } from "node:test";
import { currentSequence, EVENT_TYPES, publish, recentEvents, subscribe } from "../src/lib/bus.js";

// The bus is pure in-memory logic — no database, no Redis — so these run
// without any infrastructure, exactly like the cache invariants. What is
// pinned down here are the properties the SSE feed depends on:
//
//  - a subscriber sees every event published while it is attached;
//  - the ring buffer keeps recent events so a late joiner is not blind;
//  - sequence numbers strictly increase, which is what lets a reconnecting
//    client ask "what did I miss?" instead of guessing;
//  - a throwing subscriber cannot fail the publisher. The publisher is a
//    mutation path (a reservation, a screening); an exception propagating
//    out of `publish` would turn a live-feed glitch into a failed write,
//    which is unacceptable in an emergency workflow.

test("a subscriber receives every event published while attached", () => {
  const seen = [];
  const unsubscribe = subscribe((event) => seen.push(event));
  try {
    publish(EVENT_TYPES.RESERVATION_CREATED, { cityCode: "KHI", reservationId: "r1" });
    publish(EVENT_TYPES.UNIT_UPDATED, { cityCode: "LHE", unitId: "u1", change: "discarded" });
  } finally {
    unsubscribe();
  }
  assert.equal(seen.length, 2);
  assert.equal(seen[0].type, "reservation.created");
  assert.equal(seen[0].payload.reservationId, "r1");
  assert.equal(seen[1].type, "unit.updated");
  assert.equal(seen[1].payload.change, "discarded");
});

test("an unsubscribed listener stops receiving events", () => {
  const seen = [];
  const unsubscribe = subscribe((event) => seen.push(event));
  publish(EVENT_TYPES.SWEEP_COMPLETED, { cityCode: "KHI", released: 1, expired: 0 });
  unsubscribe();
  publish(EVENT_TYPES.SWEEP_COMPLETED, { cityCode: "KHI", released: 2, expired: 1 });
  assert.equal(seen.length, 1, "events after unsubscribe must not reach the closed listener");
});

test("sequence numbers strictly increase and are unique", () => {
  const first = currentSequence();
  const a = publish(EVENT_TYPES.INVENTORY_CHANGED, { cityCode: "KHI" });
  const b = publish(EVENT_TYPES.INVENTORY_CHANGED, { cityCode: "LHE" });
  assert.ok(a.id > first, "each event must advance the sequence");
  assert.ok(b.id > a.id, "each event must advance the sequence");
  assert.equal(currentSequence(), b.id);
});

test("recentEvents replays only events after a given id, newest last", () => {
  const before = publish(EVENT_TYPES.CHAOS_FLAG_CHANGED, { cityCode: "ISB", primaryDown: true });
  const marker = publish(EVENT_TYPES.CHAOS_FLAG_CHANGED, { cityCode: "ISB", primaryDown: false });
  const after = publish(EVENT_TYPES.CHAOS_FLAG_CHANGED, { cityCode: "KHI", primaryDown: true });

  const replay = recentEvents().filter((event) => event.id > marker.id);
  assert.deepEqual(
    replay.map((event) => event.id),
    [after.id],
    "a reconnecting stream must see exactly the events it missed",
  );
  assert.ok(recentEvents().some((event) => event.id === before.id));
});

test("the ring buffer is bounded, so a long-lived process cannot grow without limit", () => {
  for (let index = 0; index < 120; index += 1) {
    publish(EVENT_TYPES.UNIT_UPDATED, { cityCode: "KHI", unitId: `u${index}` });
  }
  const buffered = recentEvents(50);
  assert.ok(buffered.length <= 50, "the buffer must stay at its documented cap");
  const ids = buffered.map((event) => event.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "buffered events must stay ordered");
});

test("a throwing subscriber does not fail the publisher", () => {
  const boom = subscribe(() => {
    throw new Error("stream write failed");
  });
  const healthy = [];
  const collect = subscribe((event) => healthy.push(event));
  try {
    // This is the load-bearing assertion: a closed HTTP stream that throws
    // mid-write must not propagate into the mutation path that published.
    const event = publish(EVENT_TYPES.RESERVATION_UPDATED, { cityCode: "KHI", change: "dispatched" });
    assert.equal(event.type, "reservation.updated");
    assert.equal(healthy.length, 1, "the healthy subscriber must still receive the event");
  } finally {
    boom();
    collect();
  }
});
