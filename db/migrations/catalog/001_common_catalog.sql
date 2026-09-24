-- Shared enums and the compatibility function are centralized so every city
-- shard applies identical medical matching rules.
CREATE SCHEMA IF NOT EXISTS common;

DO $$ BEGIN
  CREATE TYPE common.blood_group_t AS ENUM ('A', 'B', 'AB', 'O');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE common.rh_t AS ENUM ('POS', 'NEG');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE common.component_t AS ENUM ('WHOLE_BLOOD', 'PRBC', 'PLATELETS', 'PLASMA');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE common.unit_status_t AS ENUM (
    'QUARANTINE', 'AVAILABLE', 'RESERVED', 'DISPATCHED',
    'TRANSFUSED', 'EXPIRED', 'DISCARDED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE common.reservation_status_t AS ENUM (
    'ACTIVE', 'DISPATCHED', 'COMPLETED', 'CANCELLED', 'EXPIRED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Why: this is the one SQL source of truth for compatibility; other layers
-- must compare against this function instead of reimplementing the matrix.
CREATE OR REPLACE FUNCTION common.compatible_donor(
  p_group common.blood_group_t,
  p_rh common.rh_t,
  p_comp common.component_t
)
RETURNS TABLE (g common.blood_group_t, r common.rh_t)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT candidates.g, candidates.r
  FROM (VALUES
    ('O'::common.blood_group_t, 'NEG'::common.rh_t),
    ('O'::common.blood_group_t, 'POS'::common.rh_t),
    ('A'::common.blood_group_t, 'NEG'::common.rh_t),
    ('A'::common.blood_group_t, 'POS'::common.rh_t),
    ('B'::common.blood_group_t, 'NEG'::common.rh_t),
    ('B'::common.blood_group_t, 'POS'::common.rh_t),
    ('AB'::common.blood_group_t, 'NEG'::common.rh_t),
    ('AB'::common.blood_group_t, 'POS'::common.rh_t)
  ) AS candidates(g, r)
  WHERE
    (
      p_comp <> 'PRBC'
      AND candidates.g = p_group
      AND candidates.r = p_rh
    )
    OR
    (
      p_comp = 'PRBC'
      AND (
        (p_group = 'O' AND candidates.g = 'O')
        OR (p_group = 'A' AND candidates.g IN ('O', 'A'))
        OR (p_group = 'B' AND candidates.g IN ('O', 'B'))
        OR (p_group = 'AB')
      )
      AND (p_rh = 'POS' OR candidates.r = 'NEG')
    );
$function$;

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