# DBBEMN

Distributed Blood Bank & Emergency Matching Network: a university project for city-sharded blood inventory, emergency matching, and reservation workflows.

## Run & Operate

- `pnpm run migrate` — apply numbered SQL migrations to Replit PostgreSQL.
- `pnpm run seed:small` — insert the repeatable development seed.
- `pnpm run verify:phase1` — list created schemas/tables and show seed counts.
- `pnpm run test:phase1` — run real-DB compatibility and state-machine tests.
- `pnpm run verify:invariants` — check reservation and transfusion invariants for all cities.
- Prefix each command with `SCHEMA_PREFIX=t_` for isolated test schemas.
- Required runtime env: Replit-managed `DATABASE_URL`; never request or set it manually.

## Stack

- Node.js ES modules and plain JavaScript for DBBEMN product code.
- PostgreSQL through `pg`; handwritten parameterized SQL only.
- The user-provided `SPEC.md` locks the product stack and overrides the starter's TypeScript/Drizzle defaults.

## Where things live

- `db/migrations/` — authoritative numbered PostgreSQL migrations.
- `backend/src/db/shard-router.js` — fixed city allow-list and schema identifier construction.
- `scripts/` — migration, seed, invariant, and verification commands.
- `docs/DESIGN.md` — schema tradeoffs, assumptions, and production mapping for simulated components.
- `SPEC.md` — full product and phase requirements.

## Architecture decisions

- Keep all business SQL parameterized and raw; do not add an ORM.
- City schema names must be built only by `schemasFor` from `KHI`, `LHE`, or `ISB`.
- A business write transaction must touch exactly one city's schemas.
- The `{city}_read` schema and chaos controls are SIMULATED; never call them physical replication or real failover.

## Product

Phase 1 delivers the PostgreSQL data layer only. Later phases add API workflows, matching/search, and role-specific portals as specified.

## User preferences

Implement one phase at a time and stop after that phase's required real verification output.

## Gotchas

- Apply migrations before seeding or running database tests.
- Set `SCHEMA_PREFIX=t_` for isolated verification; the prefix applies to city schemas and migration history, not `common`/`catalog`.
- Use `pnpm` in this workspace; the root preinstall rejects npm installs.

## Pointers

- `SPEC.md` defines the locked stack and phase gates.
