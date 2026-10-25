CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_donors_full_name_trgm
  ON {{HIST}}.donors USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_donors_phone_trgm
  ON {{HIST}}.donors USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_donors_id_trgm
  ON {{HIST}}.donors USING gin ((donor_id::text) gin_trgm_ops);
