-- GENERATED FILE - DO NOT EDIT BY HAND.
-- Source: db/migrations/catalog/*.sql
-- Regenerate: node scripts/sync-init-scripts.js
--
-- common schema: enums + helper functions, required by every city node
-- Mounted on: ALL nodes (db-catalog, db-khi, db-lhe, db-isb)

-- ---- 001_common_catalog.sql (common half) ----
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

-- ---- 002_donor_requests.sql ----
-- Donor call-outs: a hospital or blood bank asks a specific donor to give blood,
-- and the donor accepts or declines from their own portal.
--
-- Why a status enum: the request is a real state machine that both sides act on,
-- so the legal values are enforced by the type system rather than by convention.
DO $$ BEGIN
  CREATE TYPE common.donor_request_status_t AS ENUM (
    'PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
