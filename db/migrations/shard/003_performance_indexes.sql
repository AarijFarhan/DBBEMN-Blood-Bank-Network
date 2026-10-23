-- Indexes required by the read paths once the shards hold production-sized data.
--
-- Why a new migration instead of relying on 001: the migration registry only
-- records that a file ran, and 001 was applied before these indexes existed on
-- this deployment (the bulk load also dropped them). Re-running 001 is skipped
-- because its tables still exist, so the missing indexes would never come back.
-- Every statement here is IF NOT EXISTS, so this is safe on a fresh node too.

-- Index builds on a shard that already holds millions of rows are I/O bound;
-- these settings keep a fresh deploy from taking as long as the default would.
SET LOCAL maintenance_work_mem = '768MB';
SET LOCAL max_parallel_maintenance_workers = 2;

-- ===== Search: available stock (primary + simulated replica) =====
CREATE INDEX IF NOT EXISTS idx_units_available_search
  ON {{HOT}}.blood_units (component_type, blood_group, rh_factor, expiry_date)
  WHERE status = 'AVAILABLE';
CREATE INDEX IF NOT EXISTS idx_units_bank_status
  ON {{HOT}}.blood_units (blood_bank_id, status);
CREATE INDEX IF NOT EXISTS idx_units_expiry_sweep
  ON {{HOT}}.blood_units (expiry_date)
  WHERE status IN ('QUARANTINE', 'AVAILABLE', 'RESERVED');
CREATE INDEX IF NOT EXISTS idx_units_search_filter_expiry
  ON {{READ}}.units_search (component_type, blood_group, rh_factor, expiry_date);

-- ===== Stats: grouped counts and bank-scoped dashboards =====
CREATE INDEX IF NOT EXISTS idx_units_group_status
  ON {{HOT}}.blood_units (blood_group, rh_factor, component_type, status);
CREATE INDEX IF NOT EXISTS idx_units_bank_group_status
  ON {{HOT}}.blood_units (blood_bank_id, blood_group, rh_factor, component_type, status);

-- ===== Donor search: filters plus ORDER BY created_at DESC =====
CREATE INDEX IF NOT EXISTS idx_donors_created_at
  ON {{HIST}}.donors (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_donors_group_available_created
  ON {{HIST}}.donors (blood_group, rh_factor, is_available, created_at DESC);

-- ===== Donations: history, timeseries, and donor/bank scoped lists =====
CREATE INDEX IF NOT EXISTS idx_donations_collected_at
  ON {{HIST}}.donations (collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_donations_donor_collected
  ON {{HIST}}.donations (donor_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_donations_bank_collected
  ON {{HIST}}.donations (blood_bank_id, collected_at DESC);

-- Planner statistics are what let the new indexes actually be chosen; a bulk
-- load of tens of millions of rows leaves autovacuum far behind.
ANALYZE {{HOT}}.blood_units;
ANALYZE {{HIST}}.donors;
ANALYZE {{HIST}}.donations;
