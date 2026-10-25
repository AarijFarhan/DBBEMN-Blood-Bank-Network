CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_users_role_username
  ON catalog.users (role, username);
CREATE INDEX IF NOT EXISTS idx_users_username_trgm
  ON catalog.users USING gin (username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_email_trgm
  ON catalog.users USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_hospitals_name_trgm
  ON catalog.hospitals USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_blood_banks_name_trgm
  ON catalog.blood_banks USING gin (name gin_trgm_ops);
