# DBBEMN Design Notes

## Assumptions

- The small development seed uses fictional donor identities and no patient records; it exists only to exercise the real PostgreSQL schema.
- `common` and `catalog` are shared control-plane schemas; only city-owned operational tables are separated by city.
- `SCHEMA_PREFIX` is an optional, validated lower-case prefix for isolated test schemas; it does not rename `common` or `catalog`.

## Phase 1 database decisions

- **Logical city sharding:** each supported city (`KHI`, `LHE`, `ISB`) has `{city}_hot`, `{city}_history`, and `{city}_read` schemas. The city code is checked against a fixed allow-list before deriving a schema name. This preserves a later move to separate database servers without cross-city write dependencies.
- **Vertical fragmentation:** frequently updated blood units, reservations, idempotency records, and outbox events are in the hot schema; donor/donation history, transfusions, and status history are in the history schema. This separates frequently read/write inventory from wider historical records.
- **No cross-city foreign keys:** shard tables do not reference shared catalog tables or another city's schemas. Hospital and bank identifiers are plain values in shard rows so a city write can remain local.
- **One compatibility authority:** `common.compatible_donor` owns the blood compatibility rules. The JavaScript function is only a UI/test mirror; the SQL result is authoritative for future matching queries.
- **Database-enforced unit state machine:** the before-update trigger rejects illegal status transitions and increments the row version. The after-insert/status-update trigger writes both status history and the outbox in the same transaction, so neither can outlive a rolled-back unit change.
- **Live-reservation uniqueness:** a partial unique index on `unit_id` for `ACTIVE`/`DISPATCHED` reservations is a final database guard against double reservation, independent of API code.
- **Prefix-aware migration history:** the migration registry keys rows by both prefix and migration name. This lets tests create `t_khi_*`, `t_lhe_*`, and `t_isb_*` beside normal development schemas without marking one set as the other.
- **SIMULATED read model:** `{city}_read` is not a PostgreSQL replica. It is an outbox-fed schema that later phases will maintain asynchronously and label as SIMULATED.
- **Migration transactions:** shared catalog setup is one migration; each city's shard template is applied in its own transaction. Seed catalog rows are written separately, then each city's donor/inventory seed uses a transaction scoped to that city.

## Mapping to a real deployment

- Logical city schemas in one Replit PostgreSQL database would become separate PostgreSQL servers or independently managed clusters, one write primary per city. A global catalog/control-plane service would route city codes; shard tables would keep the same no-cross-city-write rule.
- The `{city}_read` outbox projection and artificial lag are **SIMULATED** here. Production read replicas would be physical PostgreSQL replicas maintained with streaming replication, with replica lag measured from database replication state rather than application outbox timestamps.
- `primary_down` and `replica_down` chaos flags are **SIMULATED** router behavior; they do not stop a database server or perform failover. Production primary health and promotion would use a failover manager such as Patroni, with clients discovering the elected writer through its supported endpoint.
- Any optional in-process worker balancing is **SIMULATED**. Production ingress and worker health routing would use a supported reverse proxy such as NGINX or a managed load balancer. Non-idempotent writes would still not be transparently retried.
- The Replit project's single managed PostgreSQL service cannot demonstrate physical inter-server replication or an actual partition. The design therefore distinguishes those production mechanisms from the schema-level and router-level behaviors this project can execute for real.