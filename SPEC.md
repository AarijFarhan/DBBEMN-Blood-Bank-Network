# DBBEMN — Replit Build Spec (SPEC.md)
### Distributed Blood Bank & Emergency Matching Network — Replit-compatible version

> **How this file is used:** it lives in the Repl as `SPEC.md`. The AI must re-read it at the start of every phase and must not deviate from it.

---

## 0. ROLE AND HARD RULES

You are a senior backend / PostgreSQL engineer building **DBBEMN** as a university *Distributed Databases* project **inside Replit**. **Database and backend correctness is the top priority; the UI is secondary.**

1. **Use ONLY the stack in Section 2.** No Docker, no docker-compose, no NGINX, no Redis, no MongoDB, no ClickHouse, no Weaviate, no ORMs (no Prisma / Sequelize / TypeORM / Drizzle), no TypeScript, no Next.js. If you think something else is needed, stop and ask.
2. **Raw parameterized SQL only** via `pg`. The reservation / dispatch / cancel paths must use explicit hand-written `BEGIN … COMMIT` transactions so locking is visible.
3. **No placeholders, no `TODO`, no fake/mocked data layer, no in-memory pretend database.** Everything must actually run in Replit.
4. **Do not silently change the design.** If ambiguous, write your assumption in one line (also in `docs/DESIGN.md → Assumptions`) and continue.
5. **Work one phase at a time (Section 14).** After each phase run the verification commands, show the **real output**, fix failures, and stop. Never claim something works unless you ran it.
6. **Honesty rule:** anything that is *simulated* (Section 1) must be labelled **"SIMULATED"** in code comments, in the UI, and in the docs. Never describe simulated behaviour as real replication/failover.
7. Every DB design decision gets a short "why" comment and an entry in `docs/DESIGN.md` (evaluators will ask why).
8. Plain **JavaScript, ES modules**, Node.js.

---

## 1. WHAT IS REAL vs SIMULATED ON REPLIT (be exact)

Replit provides **one** managed PostgreSQL database (`DATABASE_URL`) and no Docker. Therefore:

| Concept | Status | How |
|---|---|---|
| Horizontal fragmentation by city | **REAL (logical)** | One PostgreSQL database, **separate schema set per city** (`khi_*`, `lhe_*`, `isb_*`). All access goes through a shard router; no cross-city writes/joins. |
| Vertical fragmentation (hot vs historical) | **REAL** | Separate schemas `{city}_hot` and `{city}_history` per city. |
| Concurrency control, ACID, no double-reservation | **REAL** | Serializable tx + `FOR UPDATE SKIP LOCKED` + partial unique index + idempotency table. |
| Search/sort with indexes | **REAL** | Partial composite indexes, keyset pagination, scatter-gather across shards. |
| Read replica | **SIMULATED** | `{city}_read` schema = asynchronously maintained read model fed from an outbox, with configurable artificial lag (`REPLICA_LAG_MS`). Search reads it and may be stale. |
| Primary failure / partition / failover | **SIMULATED** | "Chaos switches" per city (Section 10) make the router behave as if the primary and/or replica were unreachable. No real node is killed. |
| Load balancing | **SIMULATED (in-process)** | Optional Node gateway that round-robins/least-conn proxies to 3 API worker processes on internal ports. |
| Load testing | **REAL (scaled down)** | `autocannon` + Node concurrency scripts against localhost. |

`docs/DESIGN.md` must include a section **"Mapping to a real deployment"** explaining how each simulated part would be done in production (separate PostgreSQL servers with streaming replication, Patroni failover, NGINX). This is what makes the design defensible.

---

## 2. LOCKED TECH STACK

- **Runtime:** Node.js (Replit default LTS), ES modules
- **Backend:** Express, `pg` (Pool, max ≈ 10), `jsonwebtoken`, `argon2` (fallback `bcryptjs` if native build fails), `zod`, `helmet`, `cors`, `express-rate-limit`, `pino`, `dotenv`-free (use Replit env/Secrets)
- **Database:** Replit's built-in **PostgreSQL** (`process.env.DATABASE_URL`)
- **Frontend:** React 18 + Vite, JavaScript, HTML, CSS (plain CSS), React Router. **Built to `frontend/dist` and served by Express on the single Replit port** (no separate dev port).
- **Tests:** Node's built-in test runner (`node --test`) + real DB. Load: `autocannon`.
- **Migrations:** numbered `.sql` files applied by a small Node runner (`npm run migrate`), templated for schema names.
- **Secrets (Replit Secrets):** `JWT_SECRET`, `JWT_REFRESH_SECRET`. Never hard-code.
- Server must listen on `0.0.0.0` and `process.env.PORT`.

**Replit-specific DB cautions (apply always):**
- The managed DB may sit behind a pooler and may suspend when idle → use only **transaction-scoped** settings (`SET LOCAL`), **no session-level advisory locks**, no `LISTEN/NOTIFY`, no reliance on session state; add connect retry with backoff for cold starts.
- Do not depend on optional extensions. Use `gen_random_uuid()` (built in) and `lower(username)` unique indexes instead of `citext`.

---

## 3. PROJECT STRUCTURE

```
SPEC.md  package.json  .replit (run = "npm start")
db/migrations/catalog/*.sql     db/migrations/shard/*.sql   (templated: {{HOT}} {{HIST}} {{READ}})
db/seed/
backend/src/{config,db,middleware,routes,services,jobs,utils}/
backend/tests/
frontend/src/    (built into frontend/dist)
scripts/  (migrate.js, seed.js, verify-invariants.js, loadtest/*.js)
gateway/gateway.js   (optional, Phase 6)
docs/  DESIGN.md  PACELC.md  API.md  EVIDENCE.md  DEMO_SCRIPT.md
```

---

## 4. DATA DISTRIBUTION DESIGN

One PostgreSQL database, schemas:

- `common` — shared enum types and the SQL compatibility function.
- `catalog` — `cities`, `hospitals`, `blood_banks`, `users`, `refresh_tokens`, `chaos_flags`.
- For each city code `c` in `KHI, LHE, ISB` (lower-case prefix): `c_hot`, `c_history`, `c_read`.

**Shard router rules (critical):**
- A single function `schemasFor(cityCode)` returns `{hot, hist, read}`; it **validates `cityCode` against the constant allow-list `['KHI','LHE','ISB']`** and throws otherwise. Schema names are the only identifiers ever interpolated into SQL and they come *only* from this function — never from user input.
- **Every write transaction touches exactly ONE city's schemas.** No cross-city writes, joins, or foreign keys — even though it is technically possible in one DB — so the design maps 1:1 to separate servers. Enforce this in code review of your own work and state it in `DESIGN.md`.
- The reservation stores `hospital_id` and `hospital_city_code` as plain columns (hospital lives in `catalog`; validate it **before** opening the shard transaction). **No FK from shard tables to `catalog`.**
- Writes → `{c}_hot` / `{c}_history`. Search reads → `{c}_read` (simulated replica) with fallback to `{c}_hot` when the read model is disabled by chaos flag.
- Tests run with env `SCHEMA_PREFIX=t_` (so schemas become `t_khi_hot` etc.) to avoid touching real data. Default prefix is empty.

---

## 5. REFERENCE SCHEMA (implement exactly; you may add comments/indexes but never remove constraints)

### 5.1 `common`
```sql
CREATE SCHEMA IF NOT EXISTS common;
CREATE TYPE common.blood_group_t AS ENUM ('A','B','AB','O');
CREATE TYPE common.rh_t          AS ENUM ('POS','NEG');
CREATE TYPE common.component_t   AS ENUM ('WHOLE_BLOOD','PRBC','PLATELETS','PLASMA');
CREATE TYPE common.unit_status_t AS ENUM ('QUARANTINE','AVAILABLE','RESERVED','DISPATCHED','TRANSFUSED','EXPIRED','DISCARDED');
CREATE TYPE common.reservation_status_t AS ENUM ('ACTIVE','DISPATCHED','COMPLETED','CANCELLED','EXPIRED');

-- SINGLE SOURCE OF TRUTH for compatibility (see Section 6.1). Returns compatible DONOR (group, rh) pairs.
CREATE FUNCTION common.compatible_donor(p_group common.blood_group_t, p_rh common.rh_t, p_comp common.component_t)
RETURNS TABLE (g common.blood_group_t, r common.rh_t) LANGUAGE sql IMMUTABLE AS $$ ... $$;
-- PRBC: matrix in 6.1.  WHOLE_BLOOD/PLATELETS/PLASMA: exact match only (returns just (p_group,p_rh)).
```

### 5.2 `catalog`
```sql
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE TABLE catalog.cities (
  city_code CHAR(3) PRIMARY KEY CHECK (city_code ~ '^[A-Z]{3}$'),
  name TEXT NOT NULL UNIQUE, latitude NUMERIC(9,6) NOT NULL, longitude NUMERIC(9,6) NOT NULL
);  -- seed: KHI Karachi 24.8607,67.0011 | LHE Lahore 31.5204,74.3587 | ISB Islamabad 33.6844,73.0479
CREATE TABLE catalog.hospitals (
  hospital_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
  city_code CHAR(3) NOT NULL REFERENCES catalog.cities, address TEXT,
  latitude NUMERIC(9,6), longitude NUMERIC(9,6), phone TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE catalog.blood_banks (                 -- same columns, PK blood_bank_id
  blood_bank_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
  city_code CHAR(3) NOT NULL REFERENCES catalog.cities, address TEXT,
  latitude NUMERIC(9,6), longitude NUMERIC(9,6), phone TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE catalog.users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL, email TEXT NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('SYSTEM_ADMIN','HOSPITAL_ADMIN','BLOODBANK_ADMIN','DONOR')),
  hospital_id UUID REFERENCES catalog.hospitals, blood_bank_id UUID REFERENCES catalog.blood_banks,
  donor_id UUID, donor_city_code CHAR(3) REFERENCES catalog.cities,
  is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((role='HOSPITAL_ADMIN' AND hospital_id IS NOT NULL) OR (role='BLOODBANK_ADMIN' AND blood_bank_id IS NOT NULL)
      OR (role='DONOR' AND donor_id IS NOT NULL AND donor_city_code IS NOT NULL) OR role='SYSTEM_ADMIN')
);
CREATE UNIQUE INDEX uq_users_username ON catalog.users (lower(username));
CREATE UNIQUE INDEX uq_users_email    ON catalog.users (lower(email));
CREATE TABLE catalog.refresh_tokens (
  token_id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES catalog.users ON DELETE CASCADE,
  token_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ
);
CREATE TABLE catalog.chaos_flags (                 -- SIMULATED failures, read by every API instance (cache ≤ 1 s)
  city_code CHAR(3) PRIMARY KEY REFERENCES catalog.cities,
  primary_down BOOLEAN NOT NULL DEFAULT FALSE,     -- writes unavailable
  replica_down BOOLEAN NOT NULL DEFAULT FALSE,     -- read model unavailable
  extra_lag_ms INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 5.3 Per-city schemas (template; `{{HOT}}`, `{{HIST}}`, `{{READ}}` = `khi_hot`, `khi_history`, `khi_read`, …, with `SCHEMA_PREFIX`)
```sql
CREATE SCHEMA {{HOT}}; CREATE SCHEMA {{HIST}}; CREATE SCHEMA {{READ}};

-- ===== history (cold / wide) =====
CREATE TABLE {{HIST}}.donors (
  donor_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), full_name TEXT NOT NULL, phone TEXT NOT NULL,
  date_of_birth DATE NOT NULL, sex CHAR(1) NOT NULL CHECK (sex IN ('M','F')),
  weight_kg NUMERIC(5,1) NOT NULL CHECK (weight_kg > 0),
  blood_group common.blood_group_t NOT NULL, rh_factor common.rh_t NOT NULL,
  city_code CHAR(3) NOT NULL, last_donation_date DATE,
  is_available BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE {{HIST}}.donations (
  donation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  donor_id UUID NOT NULL REFERENCES {{HIST}}.donors, blood_bank_id UUID NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(), volume_ml INT NOT NULL CHECK (volume_ml BETWEEN 350 AND 500),
  screening_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (screening_status IN ('PENDING','PASSED','FAILED')),
  screened_at TIMESTAMPTZ, notes TEXT
);
CREATE TABLE {{HIST}}.transfusions (
  transfusion_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), reservation_id UUID NOT NULL, unit_id UUID NOT NULL,
  hospital_id UUID NOT NULL, patient_ref TEXT NOT NULL,     -- pseudonymous reference, never a real name
  transfused_at TIMESTAMPTZ NOT NULL DEFAULT now(), outcome_notes TEXT
);
CREATE TABLE {{HIST}}.unit_status_log (
  log_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, unit_id UUID NOT NULL,
  from_status common.unit_status_t, to_status common.unit_status_t NOT NULL,
  reason TEXT, changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON {{HIST}}.unit_status_log (unit_id, changed_at);

-- ===== hot (narrow / frequently updated) =====
CREATE TABLE {{HOT}}.blood_units (
  unit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  donation_id UUID NOT NULL REFERENCES {{HIST}}.donations, blood_bank_id UUID NOT NULL,
  blood_group common.blood_group_t NOT NULL, rh_factor common.rh_t NOT NULL,
  component_type common.component_t NOT NULL, volume_ml SMALLINT NOT NULL CHECK (volume_ml > 0),
  collected_on DATE NOT NULL, expiry_date DATE NOT NULL,
  status common.unit_status_t NOT NULL DEFAULT 'QUARANTINE',
  version INT NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expiry_date > collected_on)
);
CREATE INDEX idx_units_available_search ON {{HOT}}.blood_units (component_type, blood_group, rh_factor, expiry_date) WHERE status='AVAILABLE';
CREATE INDEX idx_units_bank_status ON {{HOT}}.blood_units (blood_bank_id, status);
CREATE INDEX idx_units_expiry_sweep ON {{HOT}}.blood_units (expiry_date) WHERE status IN ('QUARANTINE','AVAILABLE','RESERVED');

CREATE TABLE {{HOT}}.reservations (
  reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), request_id UUID NOT NULL,
  unit_id UUID NOT NULL REFERENCES {{HOT}}.blood_units,
  hospital_id UUID NOT NULL, hospital_city_code CHAR(3) NOT NULL,
  patient_blood_group common.blood_group_t NOT NULL, patient_rh common.rh_t NOT NULL,
  urgency TEXT NOT NULL CHECK (urgency IN ('CRITICAL','URGENT','ROUTINE')),
  status common.reservation_status_t NOT NULL DEFAULT 'ACTIVE',
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(), hold_expires_at TIMESTAMPTZ NOT NULL,
  dispatched_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, cancel_reason TEXT
);
-- DB-LEVEL guarantee against double reservation, independent of application code:
CREATE UNIQUE INDEX uq_one_live_reservation_per_unit ON {{HOT}}.reservations (unit_id) WHERE status IN ('ACTIVE','DISPATCHED');
CREATE INDEX idx_res_hospital ON {{HOT}}.reservations (hospital_id, status);
CREATE INDEX idx_res_hold_expiry ON {{HOT}}.reservations (hold_expires_at) WHERE status='ACTIVE';
CREATE INDEX idx_res_request ON {{HOT}}.reservations (request_id);

CREATE TABLE {{HOT}}.processed_requests (          -- idempotency, one row per request_id per shard
  request_id UUID PRIMARY KEY, hospital_id UUID NOT NULL, request_hash TEXT NOT NULL,
  result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE {{HOT}}.outbox (                      -- feeds the SIMULATED replica read model
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, unit_id UUID NOT NULL,
  event_type TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== read (SIMULATED replica: only AVAILABLE units, async, lagged) =====
CREATE TABLE {{READ}}.units_search (
  unit_id UUID PRIMARY KEY, blood_bank_id UUID NOT NULL,
  blood_group common.blood_group_t NOT NULL, rh_factor common.rh_t NOT NULL, component_type common.component_t NOT NULL,
  volume_ml SMALLINT NOT NULL, collected_on DATE NOT NULL, expiry_date DATE NOT NULL
);
CREATE INDEX ON {{READ}}.units_search (component_type, blood_group, rh_factor, expiry_date);
CREATE TABLE {{READ}}.replication_state (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), last_applied_event_id BIGINT NOT NULL DEFAULT 0, last_applied_at TIMESTAMPTZ);
```

**Required triggers on `{{HOT}}.blood_units`:**
- `BEFORE UPDATE OF status`: reject illegal transitions (Section 6.3); bump `version`; set `updated_at`.
- `AFTER INSERT OR UPDATE OF status`: (a) insert into `{{HIST}}.unit_status_log`; (b) insert into `{{HOT}}.outbox` (`UNIT_UPSERT` with the fields needed by `units_search` + current status). Because these are triggers in the same transaction, no event can be lost or emitted for a rolled-back change.

---

## 6. DOMAIN RULES (medical logic must be correct)

### 6.1 Compatibility — PRBC (recipient → allowed donor units)
| Patient | Compatible donors |
|---|---|
| O− | O− |
| O+ | O−, O+ |
| A− | O−, A− |
| A+ | O−, O+, A−, A+ |
| B− | O−, B− |
| B+ | O−, O+, B−, B+ |
| AB− | O−, A−, B−, AB− |
| AB+ | all 8 |

`WHOLE_BLOOD`, `PLATELETS`, `PLASMA`: **exact ABO + Rh match only** (documented simplification). The SQL function `common.compatible_donor` is the source of truth; a JS mirror exists only for UI hints, and **a test must assert both agree for all 8×4 combinations**.

### 6.2 Shelf life (configurable)
`WHOLE_BLOOD` 35 d, `PRBC` 42 d, `PLATELETS` 5 d, `PLASMA` 365 d. A unit is **usable only if `expiry_date > CURRENT_DATE`**.

### 6.3 State machine (enforced by trigger AND conditional UPDATEs)
```
QUARANTINE → AVAILABLE | DISCARDED
AVAILABLE  → RESERVED | EXPIRED | DISCARDED
RESERVED   → AVAILABLE (hold expired/cancelled) | DISPATCHED | EXPIRED | DISCARDED
DISPATCHED → TRANSFUSED | QUARANTINE (cancelled in transit → re-inspection)
TRANSFUSED, EXPIRED, DISCARDED → terminal
```
Reservation: `ACTIVE → DISPATCHED | CANCELLED | EXPIRED`; `DISPATCHED → COMPLETED | CANCELLED`.

### 6.4 Donor eligibility (enforced on `POST /donations`)
Age 18–65, weight ≥ 50 kg, `is_available`, and ≥ `DONATION_INTERVAL_DAYS` (default 90) since `last_donation_date`. Violation → `422` with a machine-readable reason.

### 6.5 Donation → units
`POST /donations` creates one donation + one or more `QUARANTINE` units (one per component) in **one transaction**. `PATCH /donations/:id/screening`: `PASSED` → its units `AVAILABLE`; `FAILED` → `DISCARDED`. On success set `donors.last_donation_date`.

### 6.6 Selection policy for auto-matching
1. Exact match before merely-compatible. 2. FEFO (earliest expiry first). 3. Avoid using `O−` for non-`O−` patients if another compatible type has stock (unless `CRITICAL` and nothing else). 4. Cities ranked by haversine distance from the hospital, its own city first.

---

## 7. RESERVATION ENGINE & CONCURRENCY CONTROL (the heart of the project)

### 7.1 `POST /api/v1/reservations`
Body: `{ requestId(uuid), hospitalId, patientBloodGroup, patientRh, component, unitsNeeded(1–10), urgency, allowPartial=false, searchScope:"LOCAL_FIRST"|"ALL_CITIES" }`.
1. Verify JWT role `HOSPITAL_ADMIN` and `hospitalId` == token's `hospital_id`; hospital active.
2. Rank cities (6.6.4). For each city until satisfied, run the **per-city transaction (7.2)**. If a city's `primary_down` chaos flag is set, skip it and record it in `unavailableCities` (writes are never redirected — consistency over availability).
3. If `allowPartial=false` and total < needed → **compensating cancels** on units already reserved elsewhere, return `409 INSUFFICIENT_STOCK`. (Document: cross-city all-or-nothing via compensation, not 2PC.)
4. Return reservations grouped by city.

### 7.2 Per-city reservation transaction (implement exactly)
```
BEGIN ISOLATION LEVEL SERIALIZABLE;
INSERT INTO {{HOT}}.processed_requests(request_id,hospital_id,request_hash,result)
  VALUES ($1,$2,$3,'{}') ON CONFLICT (request_id) DO NOTHING RETURNING request_id;
  -- 0 rows → already processed: read stored result, COMMIT, return it (200, replayed:true).
  -- same request_id but different hash → 422 IDEMPOTENCY_KEY_REUSED.
SELECT unit_id FROM {{HOT}}.blood_units
 WHERE status='AVAILABLE' AND expiry_date > CURRENT_DATE AND component_type=$comp
   AND (blood_group, rh_factor) IN (SELECT g, r FROM common.compatible_donor($group,$rh,$comp))
 ORDER BY (blood_group=$group AND rh_factor=$rh) DESC,
          (blood_group='O' AND rh_factor='NEG' AND NOT ($group='O' AND $rh='NEG')) ASC,
          expiry_date ASC
 LIMIT $n FOR UPDATE SKIP LOCKED;
-- per locked unit:
UPDATE {{HOT}}.blood_units SET status='RESERVED' WHERE unit_id=$1 AND status='AVAILABLE' AND expiry_date > CURRENT_DATE RETURNING *;
INSERT INTO {{HOT}}.reservations(... hold_expires_at = now() + make_interval(mins => $HOLD) ...) RETURNING *;
UPDATE {{HOT}}.processed_requests SET result=$json WHERE request_id=$1;
COMMIT;
```
- `HOLD` default 30 min (CRITICAL 60).
- `withSerializableRetry(fn)`: retry on SQLSTATE `40001` and `40P01`, max 5, exponential backoff + jitter; never retry other errors.
- `23505` on `uq_one_live_reservation_per_unit` → `409 UNIT_ALREADY_RESERVED`.
- Always `ROLLBACK` on error and `release()` the client in `finally`.

### 7.3 `POST /units/:unitId/reserve?city=KHI` — same shape with `SELECT … WHERE unit_id=$1 FOR UPDATE`; status ≠ `AVAILABLE` → `409 UNIT_NOT_AVAILABLE`.
*(This is the endpoint that exposes stale simulated-replica data: search may show a unit that is already reserved; the write path re-checks on the hot table and correctly returns 409.)*

### 7.4 Dispatch / transfuse / cancel (each = one city transaction, conditional updates)
- `dispatch` (blood-bank admin of that unit's bank): reservation `ACTIVE→DISPATCHED` **and** unit `RESERVED→DISPATCHED`; either `rowCount=0` → rollback + `409`.
- `transfuse` (hospital admin): reservation `DISPATCHED→COMPLETED`, unit `DISPATCHED→TRANSFUSED`, insert `transfusions`.
- `cancel`: `ACTIVE` → unit `AVAILABLE` (or `EXPIRED` if past expiry); `DISPATCHED` → unit `QUARANTINE`.

### 7.5 Background jobs (run inside the server process on `setInterval`; must be safe if several instances run)
Every 30 s (`FOR UPDATE SKIP LOCKED` everywhere): (a) expire `ACTIVE` reservations past `hold_expires_at` → unit `AVAILABLE`; (b) mark past-expiry units `EXPIRED` and expire their live reservation; (c) archive-free: delete `outbox` rows older than 1 day that are already applied.
Every 1 s: **replica applier** per city — read outbox events with `event_id > last_applied_event_id AND created_at <= now() - (REPLICA_LAG_MS + extra_lag_ms)`, apply in order (upsert into `units_search` if status `AVAILABLE`, else delete), advance `replication_state`. Skipped entirely while `replica_down` (so lag grows — that is the demo). Measured lag = `now() - created_at` of the oldest unapplied event (0 if none).

### 7.6 Invariants (`npm run verify:invariants`, exit non-zero on violation, run per city)
- I1: no `unit_id` has >1 reservation in `ACTIVE`/`DISPATCHED`.
- I2: every `RESERVED`/`DISPATCHED` unit has exactly one live reservation and vice-versa.
- I3: no `AVAILABLE` unit has a live reservation.
- I4: every `TRANSFUSED` unit has exactly one `COMPLETED` reservation and one `transfusions` row.
- I5: no reservation was created for a unit whose `expiry_date <= reserved_at::date`.

---

## 8. API (base `/api/v1`, JSON, JWT Bearer)

Error body: `{ "error": { "code", "message", "details" } }`. Codes: `401`, `403`, `404`, `409`, `422`, `429`, `503` (+`Retry-After`).

| Group | Endpoints | Role |
|---|---|---|
| Auth | `POST /auth/register-donor`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me` | public/any |
| Catalog | `GET /cities`, `/hospitals?city=`, `/blood-banks?city=` | any |
| Admin | `POST /admin/hospitals`, `/admin/blood-banks`, `/admin/users` | SYSTEM_ADMIN |
| Donors | `GET /donors/:id`, `PATCH /donors/:id/availability`, `GET /search/donors` | donor(self)/bank |
| Donations | `POST /donations`, `PATCH /donations/:id/screening`, `GET /donations?donorId=` | bank / donor(self) |
| Units | `GET /units/:id`, `PATCH /units/:id/discard`, `GET /units?bankId=&status=` | bank admin |
| Search | `GET /search/units`, `GET /stock/summary` | hospital, bank |
| Reservations | `POST /reservations`, `POST /units/:id/reserve`, `GET /reservations/:id`, `GET /reservations?hospitalId=`, `POST /reservations/:id/dispatch`, `/transfuse`, `/cancel` | see 7 |
| Ops | `GET /health/live`, `GET /health/ready`, `GET /admin/cluster-status`, chaos endpoints (Section 10) | public / SYSTEM_ADMIN |

**Security:** argon2/bcrypt hashing; access token 15 min, refresh 7 d (hashed in DB, rotated, revocable); tenant scoping in code (bank admin only own `blood_bank_id`; hospital admin only own hospital); `helmet`; CORS allow-list; `express-rate-limit` on `/auth/*`; `zod` on every body/query; never log secrets. `GET /health/ready` returns per-city `primary_up`, `replica_up`, `replica_lag_ms`, and `instance_id`. Every response includes header `X-Instance-Id`.

---

## 9. SEARCH & SORT (fast, always callable)

`GET /search/units` — filters: `bloodGroup`, `rh`, `component`, `city` (repeatable), `expiresBefore/After`, `minVolumeMl`, `bankId`, `compatibleWith=A+` (expands via `common.compatible_donor`); text `q` (bank/city name, case-insensitive substring); sort `sortBy=expiryDate|volumeMl|collectedOn|bloodGroup|distance` + `order`; `distance` needs `fromHospitalId` (haversine); **keyset pagination** (`limit` ≤ 100, `cursor`), no `OFFSET`.

**Execution:** scatter-gather over each requested city's **`{c}_read.units_search`** in parallel (`Promise.allSettled`, per-city timeout `SEARCH_SHARD_TIMEOUT_MS`=1500), merge/sort/limit in the API. Per-city **circuit breaker** (open after 5 consecutive failures, half-open after 10 s).

**Always-callable contract:** if a city is "down" (chaos `replica_down` **and** `primary_down`, or query failure) the endpoint still returns `200` with the healthy cities and
`meta:{ shardsQueried, shardsResponded, unavailableCities:[…], partial:true, replicaLagMs:{KHI:…}, source:"SIMULATED_REPLICA" }`. If only the replica is down, fall back to `{c}_hot` (source `"PRIMARY_FALLBACK"`). Never 5xx because of one city.
Search results are **advisory**; only the reservation transaction is authoritative.

`GET /stock/summary`: counts by city × blood type × component, same rules.
Provide `EXPLAIN (ANALYZE, BUFFERS)` output in `docs/EVIDENCE.md` showing the partial indexes are used with **≥ 50k units per city** seeded.

---

## 10. LOAD BALANCING & FAILURE SIMULATION (SIMULATED — label everywhere)

**Chaos switches** (SYSTEM_ADMIN only, stored in `catalog.chaos_flags`, cached ≤ 1 s so all instances agree):
- `POST /admin/chaos/:city/primary-down` and `/primary-up` → writes for that city return `503 SHARD_WRITE_UNAVAILABLE` + `Retry-After`; never redirected.
- `POST /admin/chaos/:city/replica-down` and `/replica-up` → read model frozen (lag grows) or bypassed.
- `POST /admin/chaos/:city/lag` `{ms}` → extra artificial replica lag.
The UI shows a red "SIMULATED FAILURE" banner while any flag is active.

**Optional gateway (Phase 6):** `gateway/gateway.js` — Node `http` + `http-proxy`; listens on the public Replit port; spawns/targets 3 API workers on internal ports (e.g. 4001–4003, started as child processes); **least-connections** balancing, passive + active health checks (`/health/live`), automatic removal/re-adding of dead workers, does **not** retry non-idempotent POSTs (clients retry with the same `requestId`), adds `X-Upstream-Instance`. `npm start` launches gateway + workers. Must degrade gracefully to a single server if disabled (`ENABLE_GATEWAY=false`).

---

## 11. PACELC MAPPING (implement AND document in `docs/PACELC.md`)

| Path | Partition | Else | Implementation |
|---|---|---|---|
| Reservation/dispatch/cancel | **PC** | **EC** | Single-writer schema, serializable tx, no redirect on failure, `503` when `primary_down` |
| Search/browse | **PA** | **EL** | Served from lagged read model, partial results allowed, staleness in `meta`, never 5xx for one city |

---

## 12. FRONTEND (secondary; clean and functional)

One React app, role-based protected routes:
- **Hospital Portal:** emergency request form → ranked results (city, distance, expiry) → reserve → my reservations → confirm transfusion / cancel. Friendly 409/503 messages ("Unit just taken — showing next best match").
- **Blood Bank Portal:** inventory (filter/sort/paginate), record donation, screening result, dispatch queue, discard.
- **Donor App:** register/login, eligibility + next-eligible date, donation history, availability toggle.
- **Ops dashboard (SYSTEM_ADMIN):** per-city primary/replica status and measured lag, chaos switch buttons, instance-id of last responses, live reservation counters, "PARTIAL RESULTS" banner, a **"SIMULATED"** badge on replica/failure info.

---

## 13. TESTS & EVIDENCE (`node --test`, real DB with `SCHEMA_PREFIX=t_`)

- T1 compatibility: SQL vs JS agree on all 8×4; every row of 6.1 asserted.
- T2 state machine: every illegal transition rejected by the trigger.
- T3 **200 concurrent reservations for 1 unit → exactly 1 success, 199 × 409**; invariants pass.
- T4 N units, M>N concurrent auto-match requests → exactly N successes, no unit shared.
- T5 idempotency: same `requestId` ×10 concurrently → one reservation set, identical responses.
- T6 hold expiry releases units; re-reservable afterwards.
- T7 ≥ 500 random operation sequences (reserve/dispatch/transfuse/cancel/expire) → invariants I1–I5 hold.
- T8 search: filters, all sort keys, keyset pagination, `compatibleWith`, partial results under chaos flags, fallback to hot when `replica_down`.
- T9 stale-replica correctness: with `extra_lag_ms` high, search shows a unit already reserved → reserve returns `409` → auto-match picks another unit.
- T10 authZ cross-tenant → `403`; T11 donor eligibility rules; T12 `primary_down` → reservations `503`, search still `200`.

**Load (`scripts/loadtest/`, `autocannon`, scaled to Replit — 100–200 connections):** (a) mixed 70 % search / 30 % reserve spike; thresholds p95 search < 800 ms, error rate < 1 %; (b) hot-unit contention on a few rare `AB−` units; (c) run (a) while toggling chaos flags. **`verify:invariants` must pass after each run.** Record everything in `docs/EVIDENCE.md`.

**Seed:** `npm run seed:small` (quick) and `npm run seed` (≥ 3 cities, ≥ 5 banks, ≥ 8 hospitals, ≥ 5k donors and ≥ 50k units per city, with realistic ABO/Rh distribution).

---

## 14. PHASES (stop after each and show real verification output)

1. **Data layer:** migration runner, `common` + `catalog` + 3 city schema sets, triggers, seed:small, invariants script. *Verify:* `\dn`/table listings via a script, seed counts, T1, T2.
2. **Backend core:** config, pool with retry, shard router, auth/RBAC, catalog, donors/donations/units, health. *Verify:* API tests.
3. **Reservation engine + jobs + replica applier:** Section 7. *Verify:* T3–T7, T9 with real output.
4. **Search/sort + scatter-gather + circuit breaker + chaos switches.** *Verify:* T8, T12, EXPLAIN plans.
5. **Frontend** (built to `frontend/dist`, served by Express). *Verify:* manual walkthrough checklist in `docs/DEMO_SCRIPT.md`.
6. **(Optional) Gateway with 3 workers.** *Verify:* `X-Upstream-Instance` rotates; killing one worker loses no new requests.
7. **Load tests + `docs/EVIDENCE.md` + `docs/DESIGN.md` (incl. "Mapping to a real deployment") + `docs/PACELC.md`.**

---

## 15. DEFINITION OF DONE

- [ ] App runs from a clean Repl with only `npm run migrate && npm run seed:small && npm start`; README lists exact steps and required Secrets.
- [ ] Every table/constraint/index/trigger in Section 5 exists; illegal transitions rejected.
- [ ] T1–T12 pass; T3 shows **exactly one winner** among 200 concurrent reservations.
- [ ] `verify:invariants` = 0 after every load test and after chaos toggling.
- [ ] Search stays `200` (with `partial`/source info) under chaos; writes to a "down" city return `503`.
- [ ] No SQL built from user input (only allow-listed schema names), no ORM, no cross-city write transaction.
- [ ] All simulated parts labelled "SIMULATED" in code, UI and docs; `DESIGN.md` lists every assumption and the real-deployment mapping.

**Start with Phase 1 only. First reply with your plan in ≤ 15 lines, then write the code.**
