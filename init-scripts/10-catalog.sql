-- GENERATED FILE - DO NOT EDIT BY HAND.
-- Source: db/migrations/catalog/*.sql
-- Regenerate: node scripts/sync-init-scripts.js
--
-- catalog schema: cities, hospitals, blood_banks, users, refresh_tokens, chaos_flags
-- Mounted on: db-catalog ONLY - city nodes must never hold this

-- ---- 001_common_catalog.sql (catalog half) ----
CREATE SCHEMA IF NOT EXISTS catalog;

-- Why: city records are the fixed routing catalog used to validate shard keys.
CREATE TABLE IF NOT EXISTS catalog.cities (
  city_code CHAR(3) PRIMARY KEY CHECK (city_code ~ '^[A-Z]{3}$'),
  name TEXT NOT NULL UNIQUE,
  latitude NUMERIC(9,6) NOT NULL,
  longitude NUMERIC(9,6) NOT NULL
);

INSERT INTO catalog.cities (city_code, name, latitude, longitude)
VALUES
  ('KHI', 'Karachi', 24.860700, 67.001100),
  ('LHE', 'Lahore', 31.520400, 74.358700),
  ('ISB', 'Islamabad', 33.684400, 73.047900)
ON CONFLICT (city_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS catalog.hospitals (
  hospital_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  city_code CHAR(3) NOT NULL REFERENCES catalog.cities,
  address TEXT,
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  phone TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS catalog.blood_banks (
  blood_bank_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  city_code CHAR(3) NOT NULL REFERENCES catalog.cities,
  address TEXT,
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  phone TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS catalog.users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('SYSTEM_ADMIN', 'HOSPITAL_ADMIN', 'BLOODBANK_ADMIN', 'DONOR')),
  hospital_id UUID REFERENCES catalog.hospitals,
  blood_bank_id UUID REFERENCES catalog.blood_banks,
  donor_id UUID,
  donor_city_code CHAR(3) REFERENCES catalog.cities,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (role = 'HOSPITAL_ADMIN' AND hospital_id IS NOT NULL)
    OR (role = 'BLOODBANK_ADMIN' AND blood_bank_id IS NOT NULL)
    OR (role = 'DONOR' AND donor_id IS NOT NULL AND donor_city_code IS NOT NULL)
    OR role = 'SYSTEM_ADMIN'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username ON catalog.users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON catalog.users (lower(email));

CREATE TABLE IF NOT EXISTS catalog.refresh_tokens (
  token_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES catalog.users ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

-- Why: shared flags let every API instance observe the same simulated outages.
CREATE TABLE IF NOT EXISTS catalog.chaos_flags (
  city_code CHAR(3) PRIMARY KEY REFERENCES catalog.cities,
  primary_down BOOLEAN NOT NULL DEFAULT FALSE,
  replica_down BOOLEAN NOT NULL DEFAULT FALSE,
  extra_lag_ms INT NOT NULL DEFAULT 0 CHECK (extra_lag_ms >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO catalog.chaos_flags (city_code)
SELECT city_code FROM catalog.cities
WHERE city_code IN ('KHI', 'LHE', 'ISB')
ON CONFLICT (city_code) DO NOTHING;
