# DBBEMN — Distributed Blood Bank & Emergency Matching Network

A real-time, multi-city distributed platform for emergency blood-unit matching across
Pakistan (Karachi, Lahore, Islamabad), built on horizontally fragmented PostgreSQL.

The system is engineered around one hard requirement: **a blood unit can never be
reserved twice.** Everything else — the read model, the saga runner, the search
scatter-gather — exists to keep that guarantee while still serving broad, sorted,
multi-city searches under emergency traffic.

---

## Table of Contents

1. [Project Overview & Objectives](#1-project-overview--objectives)
2. [Architecture](#2-architecture)
3. [Technology Stack](#3-technology-stack)
4. [Repository Structure](#4-repository-structure)
5. [Database Design](#5-database-design)
6. [Concurrency Control](#6-concurrency-control)
7. [Cross-Shard Consistency (Saga)](#7-cross-shard-consistency-saga)
8. [Search & Availability](#8-search--availability)
9. [Performance Engineering](#9-performance-engineering)
10. [Setup & Configuration](#10-setup--configuration)
11. [Deployment](#11-deployment)
12. [Testing & Load Analysis](#12-testing--load-analysis)
13. [API Surface](#13-api-surface)
14. [Known Limitations](#14-known-limitations)
15. [Future Work](#15-future-work)

---

## 1. Project Overview & Objectives

### 1.1 Problem statement

A blood unit is a scarce, perishable, single-use physical resource. In an emergency, a
hospital in Karachi needs an O-negative PRBC unit within minutes. The national inventory
is not in one database — it is distributed across regional blood banks that each
maintain their own stock, donors, and expiry schedules. Reconciling them centrally is
both operationally wrong (stock changes faster than any central sync) and technically
expensive.

### 1.2 Objectives

| # | Objective | How it is met |
|---|---|---|
| O1 | **Distributed relational design** | Vertical partition of concerns (`catalog` vs. city shards) + horizontal fragmentation of inventory by city across independent PostgreSQL instances. See [§5](#5-database-design). |
| O2 | **Eliminate double-reservation** | Three independent layers: `SERIALIZABLE` transactions, `FOR UPDATE … SKIP LOCKED` row locks, and a partial unique index as an unconditional database-level guard. See [§6](#6-concurrency-control). |
| O3 | **High availability under node failure** | Scatter-gather search that degrades to partial results, a per-shard circuit breaker, replica-first reads with primary fallback, and a compensating-transaction saga for cross-shard writes. |
| O4 | **Always-available search & sort** | Keyset (cursor) pagination with HMAC-signed cursors, five sort modes including Haversine distance, and per-shard timeouts so one slow shard cannot stall a query. See [§8](#8-search--availability). |
| O5 | **Correctness of compatibility rules** | Blood-group/Rh compatibility lives *inside* PostgreSQL as `common.compatible_donor()`, so every writer — API, scripts, and future services — observes identical rules. |

### 1.3 Scope

In scope: donor registration, donation intake and screening, inventory lifecycle,
multi-city unit search, reservation/hold/dispatch/transfusion, cross-shard admin
operations, and a fault-injection harness.

Out of scope: payment processing, donor identity verification, cold-chain IoT
integration, and real inter-institution data sharing.

---

## 2. Architecture

### 2.1 System topology

```
                            ┌──────────────────────┐
        Browser  ──────────▶│   Vercel  (CDN/Edge)  │
                            │   React SPA (static) │
                            └──────────┬───────────┘
                                       │  HTTPS  /api/v1/*
                                       ▼
                            ┌──────────────────────┐
                            │  Render  (API host)  │
                            │  Express 5 · Node.js │
                            │  ┌────────────────┐  │
                            │  │ Node Gateway   │  │  N workers, active health
                            │  │ (optional)     │  │  checks, auto-restart
                            │  └───────┬────────┘  │
                            └──────────┼───────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
              ▼                        ▼                        ▼
   ┌────────────────────┐   ┌────────────────────┐   ┌────────────────────┐
   │  CATALOG NODE      │   │   KHI SHARD        │   │   LHE / ISB SHARD  │
   │  Neon PostgreSQL   │   │   Neon PostgreSQL  │   │   Neon PostgreSQL  │
   │                    │   │                    │   │                    │
   │  catalog.users     │   │  khi_history.*     │   │  *_history.*       │
   │  catalog.cities    │   │  khi_hot.*         │   │  *_hot.*           │
   │  catalog.hospitals │   │  khi_read.*        │   │  *_read.*          │
   │  catalog.blood_    │   │                    │   │                    │
   │        banks       │   │                    │   │                    │
   │  catalog.refresh_  │   │                    │   │                    │
   │        tokens      │   │                    │   │                    │
   └────────────────────┘   └────────────────────┘   └────────────────────┘
              │                        │                        │
              └────────────────────────┴────────────────────────┘
                                    │
                     common.* (enums + compatibility function)
                     deployed to EVERY node — required for
                     city shard DDL to compile at all
```

### 2.2 Why the catalog is not a shard

`catalog.users` is on the authentication hot path: every authenticated request reads it.
Copying it to each city node would create three sources of truth for credentials. The
invariant enforced by `scripts/migrate.js` is therefore asymmetric:

- the `common` half of `001_common_catalog.sql` is applied to **every** node, because
  city tables declare columns as `common.blood_group_t` and call
  `common.compatible_donor()`;
- the `catalog` half is applied to the **catalog node only** — applying it to a city
  node would silently create a split-brain copy of `catalog.users` that no request ever
  reads.

This is why `scripts/lib/db`'s single-connection Drizzle pool is deliberately **not**
used by the application: it resolves to `DATABASE_URL` only, which in distributed mode
is not a node the app reads or writes.

### 2.3 Request lifecycle (read path — search)

```
GET /api/v1/search/units?bloodGroup=O&rh=NEG&cities=KHI,LHE&sortBy=expiryDate
  │
  ├─ 1. authenticate (JWT)  →  verify signature + load catalog.users
  ├─ 2. validate (zod)      →  normalise group/Rh/component/limit
  ├─ 3. fingerprint query  →  sha256 over the canonical filter set
  ├─ 4. decode cursor      →  HMAC verify + fingerprint match
  ├─ 5. read chaos flags   →  catalog.chaos_flags (fault injection)
  ├─ 6. scatter-gather     →  Promise.allSettled over each city shard
  │        per shard:  circuit breaker allows?
  │                     ├─ yes → query *_read.units_search  (replica-first)
  │                     └─ no  → query *_hot.blood_units     (primary fallback)
  │        wrapped in a per-shard deadline (SEARCH_SHARD_TIMEOUT_MS)
  ├─ 7. merge + dedupe     →  by unitId
  ├─ 8. sort               →  in-app, deterministic tiebreak on unitId
  ├─ 9. enrich             →  ONE batched catalog query for bank/city names
  └─ 10. respond           →  { units, nextCursor, meta }
                             meta = { partial, unavailableCities,
                                      replicaLagMs, source, citySources }
```

Step 6 uses `allSettled`, not `all`: a failed shard becomes an entry in
`unavailableCities` and sets `meta.partial = true` rather than failing the whole query.
An emergency caller gets a partial answer instantly instead of no answer.

---

## 3. Technology Stack

> **Accuracy note.** This section documents the stack as it exists in the repository.
> Several commonly-associated technologies are **not** present in the code and are
> deliberately not claimed here. See [§14](#14-known-limitations) and
> [§15](#15-future-work) for the specifics.

### 3.1 Frontend

| Component | Choice | Notes |
|---|---|---|
| Framework | React 19.1.0 | Plain JavaScript + JSX. No TypeScript. |
| Build tool | Vite 7.3.2 | Dev proxy for `/api/v1` → `localhost:8080` |
| Routing | react-router-dom 6.x | Basename from `import.meta.env.BASE_URL` |
| HTTP client | **Hand-rolled `fetch` wrapper** | `frontend/src/api.js` — see below |
| Styling | Hand-written CSS | `frontend/src/styles.css` (~36 KB). **No Tailwind.** |
| State management | React `useState`/`useContext` | No Redux, no React Query, no SWR |
| Tests | None | No test runner is configured for the frontend |

The API client is a single module with two `fetch` call sites and 41 typed endpoint
definitions. It implements the axios `interceptors` pattern by hand: a central
`request()` helper attaches the bearer token, maps error responses onto a normalised
`Error` with `.status`/`.code`/`.details`, and transparently performs a
`POST /auth/refresh` + single retry on `401`.

**Dynamic API resolution.** Because the SPA and the API live on different domains in
production, the base URL is resolved at build time:

```js
// frontend/src/api.js
const RENDER_API_ORIGIN = "https://dbbemn-blood-bank-network.onrender.com";
const API_PREFIX = "/api/v1";

const configuredApiUrl = (import.meta.env.VITE_API_URL ?? "").trim().replace(/\/+$/, "");
const API_ROOT = configuredApiUrl.endsWith(API_PREFIX)
  ? configuredApiUrl
  : `${configuredApiUrl || RENDER_API_ORIGIN}${API_PREFIX}`;
```

`VITE_API_URL` accepts either a bare origin or a full path ending in `/api/v1`; trailing
slashes are normalised so the path can never be built as `//api/v1`. When unset, the
Render backend is used, so a Vercel build needs no configuration. Set it to
`http://localhost:8080` to develop against a local backend.

### 3.2 Backend

| Component | Choice | Notes |
|---|---|---|
| Runtime | Node.js, ESM (`"type": "module"`) | No build/compile step for the backend |
| Framework | **Express 5.1.0** | Plain Express — **not NestJS** |
| Database driver | `pg` 8.23 | Raw parameterised SQL, no ORM |
| Validation | `zod` 3.25 | Every route body passes `validate(schema)` |
| Auth | `jsonwebtoken` 9 | Access + refresh, HMAC-signed cursors reuse the secret |
| Password hashing | `bcryptjs` 3, cost **12** | Capped at 72 UTF-8 bytes (bcrypt truncation) |
| Security | `helmet` 8, `cors` 2.8, `express-rate-limit` 8 | Strict CORS allowlist; auth rate-limited |
| Logging | `pino` 9 | Request-id propagated via `x-request-id` |
| Gateway | `gateway/gateway.js` (Node `http`) | Optional process supervisor + load balancer. **Not Nginx.** |

### 3.3 Database

| Component | Choice |
|---|---|
| Engine | PostgreSQL (local image pinned to `postgres:18-alpine`) |
| Hosted provider | Neon — four independent endpoints, one per node |
| Local orchestration | Docker Compose, 4 containers |
| Schema management | Versioned SQL migrations + `schema_migrations` ledger |
| Type layer | Shared `common` schema of PostgreSQL enums |

### 3.4 Optional and absent by default

The cache is real but off unless you configure it, which is worth stating plainly:

| Technology | Status |
|---|---|
| Redis | **Optional.** `ioredis` is a dependency and `REDIS_URL` is read at boot. With no URL the process uses a bounded in-memory LRU. The API is fully correct either way. |
| Bloom filters | **Implemented, opt-out.** Rebuilt from the tables at boot. An untrusted filter is never consulted, so an unbuilt filter is the pre-optimisation behaviour, not a wrong answer. Disable with `BLOOM_ENABLED=false`. |
| Nginx | **Not used.** Load balancing is done by `gateway/gateway.js` (Node). |
| Tailwind CSS | **Not used.** Styling is a single hand-written stylesheet. |
| NestJS | **Not used.** The backend is plain Express. |
| Dockerised app tier | **PostgreSQL only.** `docker-compose.yml` starts the 4 database nodes; the backend runs on the host (`pnpm start`). |

See [section 9.2](#92-caching-and-presence-indexes) for what is cached and, more
importantly, what is deliberately never cached.

---

## 4. Repository Structure

pnpm workspace monorepo. `preinstall` rejects npm/yarn to guarantee a single lockfile.

```
dbbemn-blood-bank-network/
├── frontend/                     # React SPA (Vite)
│   ├── src/
│   │   ├── api.js                # ★ hand-rolled fetch client; API_URL resolution
│   │   ├── auth.jsx              # auth context, session restore
│   │   ├── App.jsx               # router
│   │   ├── constants.js          # roles, enums, labels
│   │   ├── styles.css            # the entire design system
│   │   ├── components/           # AppShell, UI primitives
│   │   ├── hooks/useRequest.js   # shared async-load hook
│   │   └── pages/                # Auth, Bank, Donor, Hospital, Request, System
│   └── vite.config.js            # dev proxy /api/v1 → :8080
│
├── backend/                      # Express API (ESM JavaScript)
│   ├── src/
│   │   ├── index.js  app.js      # server bootstrap, route mounting, static SPA
│   │   ├── config/env.js         # ★ all env parsing + validation
│   │   ├── db/
│   │   │   ├── registry.js       # ★ node → pool routing
│   │   │   ├── pool.js           # ★ SERIALIZABLE retry wrapper
│   │   │   ├── shard-router.js   # CITY_CODES, schemasFor(), writable checks
│   │   │   └── saga.js           # ★ compensating-transaction runner
│   │   ├── routes/               # auth, catalog, search, units, reservations,
│   │   │                         # donations, donors, donor-requests, chaos, health
│   │   ├── services/             # reservations, search, catalog, chaos
│   │   ├── middleware/           # auth (JWT), validate (zod), errors
│   │   ├── jobs/maintenance.js   # hold expiry + unit expiry sweeps
│   │   └── utils/                # tokens, validators, compatibility
│   └── tests/                    # phase1 / phase2 / phase3 integration suites
│
├── db/migrations/                # ★ canonical schema (real source of truth)
│   ├── catalog/
│   │   ├── 001_common_catalog.sql   # common enums + catalog.* tables + seed cities
│   │   └── 002_donor_requests.sql
│   └── shard/
│       ├── 001_city_schemas.sql     # {{HOT}}/{{HIST}}/{{READ}} templates + triggers
│       └── 002_donor_requests.sql
│
├── scripts/
│   ├── db.js                     # script-side pool registry (no JWT needed)
│   ├── migrate.js                # fan-out migration runner + drift detection
│   ├── seed.js / seed-large.js   # deterministic demo seed (small / 5k+50k per city)
│   ├── bootstrap-admin.js        # ★ creates the first SYSTEM_ADMIN
│   ├── distribute-data.js        # legacy-DB → 4-node copy, plan/apply/verify
│   ├── verify-invariants.js      # per-city invariant checks (I1, I2, …)
│   ├── verify-phase1.js          # table ownership + row-count report
│   ├── test-all.js  run-test.js  run-db-command.js
│   ├── reset-test-schemas.js     # drops prefixed test schemas only
│   ├── sync-init-scripts.js      # regenerates init-scripts from migrations
│   └── loadtest/                 # mixed.js, contention.js, harness.js
│
├── gateway/gateway.js            # optional Node load balancer / worker supervisor
├── init-scripts/                 # Docker first-boot SQL (00-common, 10-catalog, 20-city)
├── lib/                          # workspace libs
│   ├── db/                       # Drizzle scaffold — SCHEMA IS EMPTY, UNUSED
│   ├── api-spec/                 # OpenAPI spec + orval config
│   ├── api-client-react/         # orval-generated fetch client
│   └── api-zod/                  # generated Zod schemas
├── artifacts/                    # standalone sandbox/demo apps
├── docker-compose.yml            # 4 PostgreSQL nodes
├── vercel.json                   # SPA rewrite (frontend)
└── package.json                  # all pnpm scripts
```

> **`lib/db` is a dead end.** Its Drizzle schema file is comments followed by
> `export {}` — zero tables — and nothing in `backend/`, `scripts/`, or `frontend/`
> imports it. Use `db/migrations/*.sql` as the schema source of truth.

---

## 5. Database Design

### 5.1 Fragmentation strategy

**Vertical partition** splits the domain by access pattern, then **horizontal
fragmentation** splits city data by geography.

| Layer | Content | Rationale |
|---|---|---|
| `common` (all nodes) | PostgreSQL enums (`blood_group_t`, `rh_t`, `component_t`, `unit_status_t`, `reservation_status_t`, `donor_request_status_t`) + `compatible_donor()` | City shard DDL references these types, so they must exist everywhere. |
| `catalog` (1 node) | `cities`, `hospitals`, `blood_banks`, `users`, `refresh_tokens`, `chaos_flags` | Global reference data + credentials. Single source of truth. |
| `*_history` (per city) | `donors`, `donations`, `transfusions`, `unit_status_log` | Cold/wide, append-mostly, never read on the hot path. |
| `*_hot` (per city) | `blood_units`, `reservations`, `processed_requests`, `donor_requests`, `outbox` | Narrow, frequently updated, the transactional core. |
| `*_read` (per city) | `units_search`, `replication_state` | Denormalised read model of AVAILABLE units only. |

The `{hot, history, read}` split is a classic **narrow-row / wide-row** trade-off:
`blood_units` is deliberately kept narrow because it is updated on every status change
and read on every reservation attempt, while donor demographics never change after
registration and can afford a wide row that is rarely touched.

### 5.2 Key constraints

The reservation guarantee is enforced in the database, not only in application code:

```sql
-- db/migrations/shard/001_city_schemas.sql

-- A unit may have at most ONE live reservation, ever. Partial index so that
-- historical/cancelled rows never block a new booking.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_live_reservation_per_unit
  ON {{HOT}}.reservations (unit_id)
  WHERE status IN ('ACTIVE', 'DISPATCHED');

-- Users are unique case-insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username ON catalog.users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email    ON catalog.users (lower(email));
```

`catalog.users` also carries a table-level `CHECK` tying the profile columns to the
role:

```sql
CHECK (
  (role = 'HOSPITAL_ADMIN'  AND hospital_id  IS NOT NULL)
  OR (role = 'BLOODBANK_ADMIN' AND blood_bank_id IS NOT NULL)
  OR (role = 'DONOR' AND donor_id IS NOT NULL AND donor_city_code IS NOT NULL)
  OR role = 'SYSTEM_ADMIN'
)
```

Because the chain is an `OR`, a `SYSTEM_ADMIN` **must** leave all four profile columns
`NULL` — populating any one of them fails every branch and raises SQLSTATE `23514`.

### 5.3 State machine enforced in the database

Unit status transitions are validated by a `BEFORE UPDATE` trigger so that *any*
writer — API, seed script, or future service — observes the same rules:

```
QUARANTINE ──▶ AVAILABLE, DISCARDED
AVAILABLE  ──▶ RESERVED, EXPIRED, DISCARDED
RESERVED   ──▶ AVAILABLE, DISPATCHED, EXPIRED, DISCARDED
DISPATCHED ──▶ TRANSFUSED, QUARANTINE
```

An illegal transition raises `23514` with constraint name
`ck_blood_unit_status_transition`. The trigger also maintains `version` and
`updated_at` on every status change.

A second `AFTER INSERT OR UPDATE` trigger writes a `unit_status_log` row **and** an
`outbox` row in the same transaction, which is what feeds the read model
([§8](#8-search--availability)).

---

## 6. Concurrency Control

Double-booking is prevented by three independent layers. Each is sufficient on its own
for the common case; together they close the window a single mechanism would leave.

### 6.1 Layer 1 — candidate selection with `SKIP LOCKED`

When picking units to reserve, the query locks the candidate rows and **skips** any
that are already locked rather than blocking behind them:

```sql
-- backend/src/services/reservations.js :: reserveUnitsInCity
SELECT u.unit_id, u.blood_group, u.rh_factor, u.component_type,
       u.volume_ml, u.collected_on, u.expiry_date
  FROM {hot}.blood_units u
 WHERE u.status = 'AVAILABLE'
   AND u.expiry_date > CURRENT_DATE
   AND u.component_type = $1::common.component_t
   AND (u.blood_group, u.rh_factor) IN (
     SELECT g, r
     FROM common.compatible_donor(
       $2::common.blood_group_t,
       $3::common.rh_t,
       $1::common.component_t
     )
   )
 ORDER BY
   -- 1. exact group+Rh match first
   (u.blood_group = $2::common.blood_group_t
    AND u.rh_factor = $3::common.rh_t) DESC,
   -- 2. then universal-donor O-negative, but only when the patient is not O-negative
   (u.blood_group = 'O'::common.blood_group_t
    AND u.rh_factor = 'NEG'::common.rh_t
    AND NOT ($2::common.blood_group_t = 'O' AND $3::common.rh_t = 'NEG')) ASC,
   -- 3. then shortest-dated stock (FIFO)
   u.expiry_date ASC,
   u.unit_id ASC
 LIMIT $4
   FOR UPDATE SKIP LOCKED
```

Two things are worth pointing out. First, `SKIP LOCKED` is what makes concurrent
reservations *scale*: N parallel requests each claim a disjoint set of units instead of
queueing behind one row lock. Second, the `ORDER BY` is a clinical triage policy, not
just a FIFO convenience — it spends the **least scarce** compatible stock first, so
O-negative units are preserved for the patients who can only receive O-negative. The
maintenance sweeps use the same locking idiom (`FOR UPDATE OF r, u SKIP LOCKED`) so a
background expiry job never contends with a foreground reservation.

### 6.2 Layer 2 — `SERIALIZABLE` with bounded retry

Every multi-statement mutation runs under serializable isolation, retrying on
serialization failure:

```js
// backend/src/db/pool.js
export function withSerializableRetryFor(pool) {
  return async function withSerializableRetry(callback, { attempts = 5, baseDelayMs = 12 } = {}) {
    // ...acquire a FRESH client per attempt...
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    // run callback(client)
    await client.query("COMMIT");
    // on 40001: rollback, release, back off, retry with a new client
  };
}
```

Two details matter. First, each attempt acquires a **fresh** client — retrying on a
tainted connection is a common source of phantom failures. Second, the retry is
*bounded* and falls through to a `409`/`503` rather than spinning.

### 6.3 Layer 3 — the index as an unconditional guard

Application logic can be wrong. The partial unique index cannot. If two transactions
somehow both insert a live reservation for the same unit, PostgreSQL rejects the second
one with `23505` on `uq_one_live_reservation_per_unit`, and the route converts it to a
clean domain error:

```js
if (error.code === "23505" && error.constraint === "uq_one_live_reservation_per_unit") {
  throw new AppError(409, "UNIT_ALREADY_RESERVED",
    "The unit already has an active reservation.");
}
```

### 6.4 Defence in depth summary

| Layer | Mechanism | Guards against |
|---|---|---|
| 1 | `SELECT … FOR UPDATE SKIP LOCKED` | Two requests racing for the same unit; lock convoy |
| 2 | `BEGIN ISOLATION LEVEL SERIALIZABLE` + retry | Write skew across the unit/reservation pair |
| 3 | Partial unique index | Any residual bug in application logic |
| 4 | `BEFORE UPDATE` status trigger | Illegal state transitions from any writer |
| 5 | Idempotency via `processed_requests` | Client retries of the same logical request |

The fifth layer deserves note: `processed_requests` stores `request_hash` keyed by
`request_id`, claimed with `SELECT … FOR UPDATE` before work begins, so a retried
request returns the original result instead of reserving a second unit.

---

## 7. Cross-Shard Consistency (Saga)

Some operations genuinely span databases — deleting a hospital must remove it from the
catalog node *and* from every city shard's inventory. PostgreSQL cannot span two
connections in a single transaction, and two-phase commit is unavailable because the
nodes are independent servers with no shared coordinator.

`backend/src/db/saga.js` implements a compensating-transaction saga: each step runs in
its own node-local transaction and returns an undo closure built from
`DELETE … RETURNING *`.

```js
const outcome = await step.run();      // { value, compensate }
```

On failure, undo actions run in **reverse order** (later steps may depend on rows
earlier steps removed). Every destructive step captures its rows first — which is
precisely why the code uses `RETURNING *` — so the compensation can reinsert them.

The module documents its own limitation honestly: compensation is best-effort. If an
undo step fails (node down mid-compensation) the database is left partially deleted, and
this is **reported, not swallowed**. A production deployment would additionally want a
durable intent log so an interrupted saga could be completed on restart.

---

## 8. Search & Availability

Search is the endpoint that matters in an emergency, and it is the most carefully
built part of the system.

### 8.1 Scatter-gather with partial results

Each requested city is queried concurrently via `Promise.allSettled`. A failed shard is
recorded, not thrown:

```js
const settled = await Promise.allSettled(
  cities.map((cityCode) => runShard(cityCode, flags[cityCode], queryForSource)),
);
```

The response always carries an honesty block:

```json
{
  "meta": {
    "shardsQueried": 3,
    "shardsResponded": 2,
    "unavailableCities": ["ISB"],
    "partial": true,
    "source": "PRIMARY_FALLBACK",
    "citySources": { "KHI": "SIMULATED_REPLICA", "LHE": "PRIMARY_FALLBACK" },
    "replicaLagMs": { "KHI": 12, "LHE": 30, "ISB": 0 }
  }
}
```

A caller can always tell a complete answer from a degraded one.

### 8.2 Read-replica-first with primary fallback

Per shard, the query prefers the read model and falls back to the primary:

```
circuit breaker open?  ──yes──▶  primary (if primaryDown → ShardUnavailableError)
        │ no
        ▼
  query *_read.units_search  ──fail──▶  mark failure, fall back to primary
        │ success
        ▼
  reset breaker, return { source: "SIMULATED_REPLICA" }
```

The **circuit breaker** is per-city and in-process: 5 consecutive failures open it,
and it half-opens after 10 s. This stops a dead shard from adding its full timeout to
every single query.

The **per-shard deadline** (`SEARCH_SHARD_TIMEOUT_MS`, default 1500 ms) is implemented
with `Promise.race` against a timer. It bounds total query latency independently of
PostgreSQL's own `statement_timeout`.

### 8.3 Keyset pagination with signed cursors

`OFFSET` degrades badly on large tables and can skip or repeat rows. Search instead
uses keyset pagination: the cursor holds the last row's sort value **plus its
`unitId` as a tiebreaker**, so ordering is total and stable.

Cursors are HMAC-signed with the JWT secret and compared with `timingSafeEqual`:

```js
export function encodeSearchCursor(payload) {
  const body = Buffer.from(JSON.stringify({ version: CURSOR_VERSION, ...payload }))
    .toString("base64url");
  return `${body}.${cursorSignature(body)}`;   // HMAC-SHA256
}
```

Decoding rejects a cursor whose embedded `fingerprint` (a SHA-256 of the whole filter
set) does not match the current query. A cursor can therefore never be replayed against
a *different* filter and silently return a wrong page.

### 8.4 Sort modes

`expiryDate`, `volumeMl`, `collectedOn`, `bloodGroup`, and `distance`. Distance is
computed in SQL with the Haversine formula against the requesting hospital's
coordinates (falling back to city-centre coordinates when a hospital has no
coordinates), and requires `fromHospitalId`:

```sql
6371 * 2 * asin(sqrt(least(1::double precision,
  power(sin(radians(COALESCE(b.latitude, c.latitude) - $lat) / 2), 2)
  + cos(radians($lat)) * cos(radians(COALESCE(b.latitude, c.latitude)))
  * power(sin(radians(COALESCE(b.longitude, c.longitude) - $lon) / 2), 2))))
```

### 8.5 Compatibility resolution

A single `compatibleWith=O+` filter is expanded **in the database** by
`common.compatible_donor(group, rh, component)`. Keeping this rule in a SQL function
rather than in JavaScript guarantees the API, the load tests, and any future writer
cannot disagree about what "O-negative can receive" means.

### 8.6 Outbox-driven read model

The read model is kept current by a transactional outbox, not by triggers writing
across schemas and not by application code remembering to:

```
UPDATE blood_units SET status = ...        (one transaction)
   ├─ BEFORE trigger: validate transition, bump version
   └─ AFTER trigger:  INSERT unit_status_log  +  INSERT outbox (UNIT_UPSERT)
                                    │
                    replay worker reads outbox
                                    ▼
                    INSERT into *_read.units_search (upsert)
                    UPDATE replication_state.last_applied_event_id
```

Because the outbox write shares the transaction with the status change, an event can
never be lost. `replication_state` records the high-water mark, making the replay
resumable and idempotent.

---

## 9. Performance Engineering

### 9.1 What is actually implemented

| Technique | Where | Effect |
|---|---|---|
| Partial indexes on the hot access path | `idx_units_available_search`, `idx_units_bank_status`, `idx_units_expiry_sweep` | Each index is scoped to the statuses the query actually filters on, so it stays small. |
| Narrow hot schema | `{hot}.blood_units` vs `{hot*_history}.donors` | Fewer bytes per tuple in the buffer cache for the table updated on every reservation. |
| Denormalised read model | `*_read.units_search` | Search reads a flat, `WHERE status='AVAILABLE'`-free projection with no join to `blood_units`. |
| Batched catalog enrichment | `loadBankDirectory()` | **One** catalog round trip per search, not one per shard — the shard query returns only `blood_bank_id`. |
| `SKIP LOCKED` batching | reservations + maintenance | Concurrent workers claim disjoint row sets; no lock convoy. |
| Per-shard circuit breaker | `search.js` | A dead shard costs one failed attempt, not a timeout on every query. |
| Per-shard deadline | `Promise.race` | Bounds worst-case search latency below the gateway timeout. |
| Composite keyset cursors | `encodeSearchCursor` | Constant-cost paging; no `OFFSET` degradation. |
| Connection pooling | `pg.Pool` per node | `backend/src/db/registry.js` maps node label → pool. |
| Rate limiting | `authLimiter` on `/api/v1/auth` | 30 requests / 15 min, protecting bcrypt (cost 12) from abuse. |
| Strict CORS allowlist | `backend/src/app.js` | Unknown origins get `403 CORS_ORIGIN_DENIED` before any query runs. |
| Version-stamped read cache | `backend/src/cache/` | Repeat emergency searches skip the scatter-gather entirely. |
| Bloom presence index | `backend/src/cache/bloom.js` | Cross-shard detail lookups skip cities that cannot hold the record. |
| Access-token revocation list | `backend/src/cache/revocations.js` | Logout invalidates the access token immediately, not in 15 minutes. |

### 9.2 Caching and presence indexes

`blood_units` changes on every reservation, so the question is not "can we cache"
but "what is it safe to serve". The design answers that by refusing to cache
anything it cannot prove is current, rather than by trusting short TTLs.

**Search and summary caching is version-stamped, not time-based.** Each city has
an inventory version counter. Every write that could change what a search returns
bumps it, and the counter is folded into the cache key. A write therefore does not
need to find and delete the affected keys — it makes them *unreachable*, which
also works across instances where a delete could not. The per-entry TTL
(`CACHE_SEARCH_TTL`, default 10s) is only a backstop for a missed bump.

Three things are deliberately never served from cache:

| Never cached | Why |
|---|---|
| A read where **any shard was unavailable** | A partial answer under-reports available blood. Caching it would keep hiding real stock after the shard recovered, which is the failure mode this whole section exists to prevent. |
| An entry written under a **different topology** | Each entry stores a signature of the chaos flags. A payload labelled `SIMULATED_REPLICA` is not replayed once that replica is down, because the API would be claiming a read it never made. Replica *lag* is excluded from the signature, since including it would discard hits every few seconds. |
| Anything at all, when the **cache is unavailable** | Every operation is best-effort and swallows errors into a miss. A cache outage must cost throughput, not availability. |

One interaction is worth calling out because it is easy to get wrong. Search reads
the *replica*, and the replica is updated asynchronously by `applyReplicaBatch`.
Invalidating only on the primary write would let the cache pin a pre-applier
answer for a further 10 seconds, making reads staler than they were before
caching existed. So the applier bumps the version itself, at the moment the read
model actually changes. It tracks genuine visibility changes only — re-applying an
identical unit row is not one — otherwise the 1-second applier loop would
invalidate the cache continuously.

**The Bloom filter can only make lookups faster, never wrong.** It answers
"definitely absent" or "possibly present", and is used solely to skip a shard
that cannot hold a record. A false positive costs one wasted query; a false
negative is impossible by construction. The one way to *create* a false negative
is a filter that has drifted from its table, so:

- a filter is consulted only if it carries a **trust marker**, granted solely by a
  rebuild from the authoritative table;
- a **mutation epoch** counter catches inserts that reached the table but not the
  filter (a row committed while the cache was down), which the marker alone would
  miss;
- a failed insert **untrusts** the filter rather than letting it lie;
- **an untrusted filter returns every city**, so behaviour is identical to the
  original sequential scan.

In the in-memory backend the bit store is deliberately *not* the bounded LRU used
for ordinary entries. Evicting a set bit would manufacture false negatives, so it
grows a fixed bit array and forgets nothing. Redis needs no equivalent —
`SETBIT` grows in place.

Run `pnpm cache:rebuild` after a cache outage or a change to the loaders. It can
only restore performance; it cannot change an answer.

**Scaling past one instance requires `REDIS_URL`.** The in-memory version counter
and its cache entries live in the same process, which is self-consistent for one
instance and wrong for two: a bump on instance A cannot invalidate instance B's
cache, and a logout recorded on A is invisible to B. The process logs a warning
on every read path until `REDIS_URL` is set.

**Revocation list.** Access tokens now carry a `jti`; logout blacklists it until
the token's own expiry, so sign-out takes effect immediately instead of allowing
up to 15 more minutes of access. Tokens minted before this change have no `jti`
and are treated as un-revocable rather than rejected. The check fails **open** on
a cache error: a revoked token slipping through is a narrower exposure than an
outage that locks every user out.

Tests: `pnpm test:cache` (15 assertions, no database required). These run first
in `pnpm test` because they are pure logic and fail fast. They pin the
no-false-negative property exhaustively rather than by sampling — a bounded LRU
evicting bits, and an `every` written as `some`, both passed a naive
correctness-only check while being badly broken.

---

## 10. Setup & Configuration

### 10.1 Prerequisites

- Node.js 20+ (uses `node --env-file-if-exists`)
- pnpm 9+ (npm/yarn are blocked by a `preinstall` guard)
- Docker Desktop — *or* four reachable PostgreSQL endpoints
- Optional: a Neon account for a hosted topology

### 10.2 Environment variables

Copy the template and fill it in:

```bash
cp .env.example .env
```

**Database topology**

| Variable | Default | Purpose |
|---|---|---|
| `DB_MODE` | inferred | `single` or `distributed`. If unset, presence of any `*_DATABASE_URL` implies distributed. |
| `DATABASE_URL` | — | Required in `single` mode. |
| `CATALOG_DATABASE_URL` | `DATABASE_URL` | Catalog node — **where `catalog.users` lives**. |
| `KHI_DATABASE_URL` | `DATABASE_URL` | Karachi shard. |
| `LHE_DATABASE_URL` | `DATABASE_URL` | Lahore shard. |
| `ISB_DATABASE_URL` | `DATABASE_URL` | Islamabad shard. |

> In `distributed` mode all four of `CATALOG_/KHI_/LHE_/ISB_DATABASE_URL` are mandatory;
> the script and app pool registries both throw if any is missing. Writing
> `catalog.users` to a city node is the split-brain the whole design prevents — if you
> cannot find a user in the database, check you are querying `CATALOG_DATABASE_URL`.

**Server**

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port (validated 1–65535). |
| `INSTANCE_ID` | random UUID | Echoed in the `X-Instance-Id` response header. |
| `CORS_ORIGINS` | — | Comma-separated **allowlist**. Anything else gets `403`. |
| `FRONTEND_DIST` | `../frontend/dist` | Built SPA to serve for single-origin hosting. |

**Secrets** (required in any non-development environment)

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs access tokens **and** search cursors. |
| `JWT_REFRESH_SECRET` | Signs refresh tokens. |

**Domain policy** (all range-validated at boot)

| Variable | Default | Purpose |
|---|---|---|
| `DONATION_INTERVAL_DAYS` | `90` | Minimum gap between a donor's donations. |
| `HOLD_MINUTES` | `30` | Default reservation hold. |
| `CRITICAL_HOLD_MINUTES` | `60` | Hold for `CRITICAL` urgency. |
| `REPLICA_LAG_MS` | `750` | Simulated replica lag reported by `chaos`. |
| `SEARCH_SHARD_TIMEOUT_MS` | `1500` | Per-shard search deadline. |

**Cache and presence indexes** (all optional — see [§9.2](#92-caching-and-presence-indexes))

`REDIS_URL` (unset → bounded in-memory LRU; **required** before running more than one
API instance), `CACHE_KEY_PREFIX` (`dbbemn`), `CACHE_ENABLED` (`true`),
`CACHE_SEARCH_TTL` (`10`), `CACHE_SUMMARY_TTL` (`20`), `CACHE_DIRECTORY_TTL` (`60`),
`CACHE_SEARCH_MAX_TTL` (`15`, hard ceiling on any search entry), and
`CACHE_MEMORY_MAX_ENTRIES` (`5000`, in-memory LRU only). `BLOOM_ENABLED` (`true`),
`BLOOM_EXPECTED_ITEMS` (`50000`, expected rows per city per table),
`BLOOM_ERROR_RATE` (`0.001`). Sizing affects only the false-positive rate, never
correctness — an undersized filter costs queries, not answers.

**Gateway** (only when `ENABLE_GATEWAY` is set)

`GATEWAY_WORKERS` (3), `GATEWAY_WORKER_BASE_PORT` (4001), `GATEWAY_HEALTH_PATH`
(`/api/v1/health/live`), `GATEWAY_HEALTH_INTERVAL_MS` (2000),
`GATEWAY_HEALTH_TIMEOUT_MS` (1000), `GATEWAY_REQUEST_TIMEOUT_MS` (30000),
`GATEWAY_RESTART_DELAY_MS` (2000).

**Frontend**

`VITE_API_URL` — see [§3.1](#31-frontend). Any `VITE_*` variable is inlined into the
public bundle at build time; never put a secret in one.

### 10.3 Local development

```bash
# 1. install
pnpm install

# 2. start the four PostgreSQL nodes
docker compose up -d
#    published on 5436 (catalog), 5433 (khi), 5434 (lhe), 5435 (isb)

# 3. apply migrations (idempotent, fans out to each node)
pnpm migrate

# 4. optional demo data
pnpm seed:small     # deterministic: 2 donors, 2 units per city
pnpm seed           # large: 5,000 donors + 50,000 units per city

# 5. create the first system administrator (interactive)
pnpm bootstrap:admin

# 6. run
pnpm dev            # API with --watch on :8080
cd frontend && pnpm dev   # Vite on :5173, proxying /api/v1 → :8080
```

`pnpm seed` and `pnpm seed:small` are **demo data only** and are not required to run
the application. Rows they create are tagged so they can be identified and removed:
IDs prefixed `10000000-`/`11000000-` (banks), `20000000-`/`21000000-` (hospitals),
`30000000-`/`50000000-` (donors/units), donor names `SIMULATED large seed donor …`, and
donation notes `SIMULATED large seed` / `Development demo seed`.

### 10.4 Useful scripts

| Command | Effect |
|---|---|
| `pnpm migrate` | Apply migrations to every node, with drift detection. |
| `pnpm bootstrap:admin` | Create the **first** `SYSTEM_ADMIN`. Refuses if one exists. |
| `pnpm cache:rebuild` | Rebuild presence filters from the tables. `-- --city=KHI` for one node. |
| `pnpm test:cache` | Cache and presence-index invariants. No database needed. |
| `pnpm verify:invariants` | Per-city invariant checks. |
| `pnpm verify:phase1` | Which tables each node owns, plus row counts. |
| `pnpm test` | Full pipeline: reset test schemas → migrate → seed → verify → phase tests. |
| `pnpm loadtest:mixed` | Mixed read/write workload against a running API. |
| `pnpm loadtest:contention` | Deliberate reservation contention — the double-booking test. |
| `pnpm data:distribute` | Copy a legacy single DB into the 4-node topology. |
| `pnpm reset-test-schemas` | Drop prefixed test schemas. Refuses on an empty prefix. |

> `bootstrap:admin` requires an interactive TTY (it disables echo for the password) and
> enforces a 12-character minimum. `bcrypt` silently truncates past 72 **bytes**, which
> is why the app caps passwords at 72 UTF-8 bytes.

---

## 11. Deployment

### 11.1 Backend on Render

| Setting | Value |
|---|---|
| Root directory | repository root |
| Build command | `pnpm install --frozen-lockfile` |
| Start command | `pnpm start` |
| Health check path | `/api/v1/health/live` |

Required environment variables on Render: `JWT_SECRET`, `JWT_REFRESH_SECRET`,
`CORS_ORIGINS`, `DB_MODE=distributed`, and all four `*_DATABASE_URL` values.

> **`CORS_ORIGINS` is not optional.** `backend/src/app.js` enforces an allowlist and
> returns `403 CORS_ORIGIN_DENIED` to any origin not listed. Set it to your Vercel
> domain, or every API call from the deployed SPA will fail in the browser even though
> the backend is healthy.

### 11.2 Frontend on Vercel

| Setting | Value |
|---|---|
| Root directory | `frontend` |
| Build command | `pnpm build` |
| Output directory | `dist` |
| Env | `VITE_API_URL` — optional; falls back to the Render origin |

`vercel.json` at the repository root provides the SPA rewrite so client-side routes
deep-link correctly:

```json
{ "rewrites": [ { "source": "/((?!api/).*)", "destination": "/index.html" } ] }
```

### 11.3 Single-origin alternative

`backend/src/app.js` can serve the built SPA itself, mounting it under `/api` with a
fallback to `index.html`. In that mode the frontend needs no `VITE_API_URL` at all,
because requests are same-origin. Choose one or the other, not both.

### 11.4 Database

Neon provisions one PostgreSQL endpoint per node. Apply migrations once (from a machine
that can reach all four) with `pnpm migrate`; the app does not migrate at boot.

---

## 12. Testing & Load Analysis

| Suite | Scope |
|---|---|
| `phase1` | Schema, topology, and table-ownership verification. |
| `phase2` | Catalog, auth, donors, donations, and admin flows. |
| `phase3` | Reservations, dispatch, transfusion, cancellations. |
| `verify-invariants` | Per-city data invariants (I1, I2, …). |
| `loadtest:mixed` | Mixed search/reserve traffic through the real HTTP API. |
| `loadtest:contention` | Many concurrent reservations competing for a small unit pool — the empirical test of §6. |

Tests run against **prefixed schemas** (`t_`, `p3_`) so they never touch development
data, and `reset-test-schemas.js` refuses to run with an empty prefix.

The fault-injection harness (`catalog.chaos_flags`, `REPLICA_LAG_MS`) lets
`/chaos` routes force a shard's primary or replica "down" so the circuit breaker,
timeout, and partial-result paths in §8 can be exercised deterministically rather than
waiting for a real outage.

The frontend has **no automated test suite** — the only automated gate available for a
frontend change is `pnpm --filter @workspace/frontend build`.

---

## 13. API Surface

All routes are mounted under `/api/v1`. Authentication is `Authorization: Bearer`.

| Namespace | Representative endpoints |
|---|---|
| `auth` | `POST /auth/login`, `POST /auth/register-donor`, `GET /auth/me`, `POST /auth/refresh`, `POST /auth/logout` |
| `catalog` | `GET /cities`, `GET /hospitals`, `GET /blood-banks` |
| `search` | `GET /search/units`, `GET /search/donors` |
| `stock` | `GET /stock/summary` |
| `units` | `GET /units`, `GET /units/:id`, `POST /units/:id/reserve`, `POST /units/:id/discard` |
| `donations` | `GET /donations`, `POST /donations`, `PATCH /donations/:id/screening` |
| `donors` | `GET /donors/:id`, `GET /donors/:id/availability` |
| `donor-requests` | `GET|POST /donor-requests`, `POST /donor-requests/:id/respond`, `DELETE /donor-requests/:id` |
| `reservations` | `GET /reservations`, `POST /reservations`, `POST /reservations/:id/cancel`, `/dispatch`, `/transfuse` |
| `admin` | `GET|POST /admin/users`, `GET|POST|DELETE /admin/hospitals`, `.../blood-banks`, `.../donors`, chaos + cluster routes |
| `health` | `GET /health/live`, `GET /health/ready` |

`GET /health/live` is the gateway and platform health path. Admin routes require an
existing `SYSTEM_ADMIN` token — which is why the first administrator must be created
out-of-band via `pnpm bootstrap:admin`: the admin API cannot bootstrap itself.

---

## 14. Known Limitations

Stated plainly, because they bound what the system can honestly claim.

1. **The cache is per-process unless `REDIS_URL` is set.** Correct for one instance,
   unsound for several: version counters and cache entries live together in memory, so a
   bump on one instance cannot invalidate another's cache, and a logout revocation is
   invisible to other instances. Redis-backed mode removes this; the code warns on every
   path until it is configured. **The Redis path itself has only been exercised against
   the in-memory backend in the test suite** — run it once against a real Redis before
   relying on it in production.
2. **A presence filter can be lost in a narrow window.** If a process dies between a row
   committing and its filter insert, the mutation epoch never increments and the filter
   is trusted while missing a record. The window is one cache call wide. `pnpm
   cache:rebuild` on deploy and after a cache outage is the remedy; a transactional
   outbox for cache invalidation would close it properly.
3. **Cached search results are as fresh as the simulated replica, not the primary.** A
   unit reserved a moment ago may still appear in a cached search until the applier
   catches up, because search reads `*_read`. This is pre-existing replica semantics that
   caching does not worsen — the applier bumps the version when the read model changes —
   but a caller must not treat a search result as a reservation.
4. **The read model is simulated, not streamed.** It is outbox-driven within a single
   node, not logical/logical streaming replication. Shard schemas are named
   `*_read` and responses are tagged `SIMULATED_REPLICA` to make this explicit rather
   than let a reader assume real replication.
5. **In-process circuit breakers.** Breaker state lives in one Node process. Across
   multiple API instances each keeps its own counters, so breaker state is not shared.
6. **Saga compensation is best-effort.** A failure *during* compensation leaves partial
   state. There is no durable intent log for crash recovery.
7. **The catalog node is a single point of failure for authentication.** Every
   authenticated request reads `catalog.users`. Sharding by geography removes
   inventory SPOFs but introduces an auth SPOF; removing it needs either a read replica
   or token self-containment.
8. **No frontend test suite.**
9. **Legacy scaffolding in `lib/`.** `lib/db` is an empty Drizzle schema; `lib/api-spec`
   and `lib/api-client-react` cover only `/api/healthz` and are not imported by the
   frontend.

---

## 15. Future Work

- **Exercise and load-test the Redis path.** The in-memory backend is the only one
  covered by `pnpm test:cache`. Redis is the mode that actually matters for multi-instance
  deploys, and its `SETBIT`/`GETBIT` behaviour under concurrent pipeline use is untested.
- **Transactional cache invalidation.** Replace the post-commit version bump with an
  outbox event so a crash between commit and invalidation cannot leave a stale entry
  reachable, which would also close limitation 2.
- **Group- and component-partitioned presence indexes.** The current filter answers
  "does this city hold this unit id". A per-`(city, blood group, component)` index would
  let a whole-group search skip a shard without touching it.
- **Real streaming replication** replacing the simulated read model, with lag-based
  freshness guarantees surfaced in `meta`.
- **Shared circuit-breaker state** (or a breaker per instance with a shared health
  view) for multi-instance deployments.
- **Durable saga intent log** so an interrupted cross-shard operation can be completed
  or rolled forward after a crash.
- **Auth SPOF removal** via a `catalog.users` read replica or self-contained access
  tokens.
- **Frontend tests** — at minimum, unit tests for the API client's URL resolution,
  refresh-and-retry path, and cursor handling.
- **Observability** — Prometheus metrics for search p95, cache hit ratio, breaker state
  transitions, and saga compensation frequency.

---

## License

Academic project. See repository history for authorship and contribution terms.
