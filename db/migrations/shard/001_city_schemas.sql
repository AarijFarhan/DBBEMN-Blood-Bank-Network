-- These three schemas are one logical city shard. Each city's write paths
-- target only its hot/history schemas; the read schema is a SIMULATED replica.
CREATE SCHEMA IF NOT EXISTS {{HOT}};
CREATE SCHEMA IF NOT EXISTS {{HIST}};
CREATE SCHEMA IF NOT EXISTS {{READ}};

-- ===== History (cold / wide) =====
CREATE TABLE IF NOT EXISTS {{HIST}}.donors (
  donor_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  date_of_birth DATE NOT NULL,
  sex CHAR(1) NOT NULL CHECK (sex IN ('M', 'F')),
  weight_kg NUMERIC(5,1) NOT NULL CHECK (weight_kg > 0),
  blood_group common.blood_group_t NOT NULL,
  rh_factor common.rh_t NOT NULL,
  city_code CHAR(3) NOT NULL,
  last_donation_date DATE,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS {{HIST}}.donations (
  donation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  donor_id UUID NOT NULL REFERENCES {{HIST}}.donors,
  blood_bank_id UUID NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  volume_ml INT NOT NULL CHECK (volume_ml BETWEEN 350 AND 500),
  screening_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (screening_status IN ('PENDING', 'PASSED', 'FAILED')),
  screened_at TIMESTAMPTZ,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS {{HIST}}.transfusions (
  transfusion_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL,
  unit_id UUID NOT NULL,
  hospital_id UUID NOT NULL,
  patient_ref TEXT NOT NULL,
  transfused_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome_notes TEXT
);

CREATE TABLE IF NOT EXISTS {{HIST}}.unit_status_log (
  log_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id UUID NOT NULL,
  from_status common.unit_status_t,
  to_status common.unit_status_t NOT NULL,
  reason TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unit_status_log_unit_changed
  ON {{HIST}}.unit_status_log (unit_id, changed_at);

-- ===== Hot (narrow / frequently updated) =====
CREATE TABLE IF NOT EXISTS {{HOT}}.blood_units (
  unit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  donation_id UUID NOT NULL REFERENCES {{HIST}}.donations,
  blood_bank_id UUID NOT NULL,
  blood_group common.blood_group_t NOT NULL,
  rh_factor common.rh_t NOT NULL,
  component_type common.component_t NOT NULL,
  volume_ml SMALLINT NOT NULL CHECK (volume_ml > 0),
  collected_on DATE NOT NULL,
  expiry_date DATE NOT NULL,
  status common.unit_status_t NOT NULL DEFAULT 'QUARANTINE',
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expiry_date > collected_on)
);

CREATE INDEX IF NOT EXISTS idx_units_available_search
  ON {{HOT}}.blood_units (component_type, blood_group, rh_factor, expiry_date)
  WHERE status = 'AVAILABLE';
CREATE INDEX IF NOT EXISTS idx_units_bank_status
  ON {{HOT}}.blood_units (blood_bank_id, status);
CREATE INDEX IF NOT EXISTS idx_units_expiry_sweep
  ON {{HOT}}.blood_units (expiry_date)
  WHERE status IN ('QUARANTINE', 'AVAILABLE', 'RESERVED');

CREATE TABLE IF NOT EXISTS {{HOT}}.reservations (
  reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL,
  unit_id UUID NOT NULL REFERENCES {{HOT}}.blood_units,
  hospital_id UUID NOT NULL,
  hospital_city_code CHAR(3) NOT NULL,
  patient_blood_group common.blood_group_t NOT NULL,
  patient_rh common.rh_t NOT NULL,
  urgency TEXT NOT NULL CHECK (urgency IN ('CRITICAL', 'URGENT', 'ROUTINE')),
  status common.reservation_status_t NOT NULL DEFAULT 'ACTIVE',
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hold_expires_at TIMESTAMPTZ NOT NULL,
  dispatched_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT
);

-- Why: the partial unique index is the final database-level guard against
-- double reservation, even if application-level locking is bypassed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_live_reservation_per_unit
  ON {{HOT}}.reservations (unit_id)
  WHERE status IN ('ACTIVE', 'DISPATCHED');
CREATE INDEX IF NOT EXISTS idx_res_hospital
  ON {{HOT}}.reservations (hospital_id, status);
CREATE INDEX IF NOT EXISTS idx_res_hold_expiry
  ON {{HOT}}.reservations (hold_expires_at)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_res_request
  ON {{HOT}}.reservations (request_id);

CREATE TABLE IF NOT EXISTS {{HOT}}.processed_requests (
  request_id UUID PRIMARY KEY,
  hospital_id UUID NOT NULL,
  request_hash TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Why: the outbox is committed atomically with hot-table changes and feeds the
-- SIMULATED asynchronous read model without LISTEN/NOTIFY or session state.
CREATE TABLE IF NOT EXISTS {{HOT}}.outbox (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Read (SIMULATED replica: only AVAILABLE units, asynchronously applied) =====
CREATE TABLE IF NOT EXISTS {{READ}}.units_search (
  unit_id UUID PRIMARY KEY,
  blood_bank_id UUID NOT NULL,
  blood_group common.blood_group_t NOT NULL,
  rh_factor common.rh_t NOT NULL,
  component_type common.component_t NOT NULL,
  volume_ml SMALLINT NOT NULL,
  collected_on DATE NOT NULL,
  expiry_date DATE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_units_search_filter_expiry
  ON {{READ}}.units_search (component_type, blood_group, rh_factor, expiry_date);

CREATE TABLE IF NOT EXISTS {{READ}}.replication_state (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  last_applied_event_id BIGINT NOT NULL DEFAULT 0,
  last_applied_at TIMESTAMPTZ
);

-- Why: status rules live in PostgreSQL so every writer, including future
-- scripts and concurrent API instances, observes the same state machine.
CREATE OR REPLACE FUNCTION {{HOT}}.enforce_blood_unit_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'QUARANTINE' AND NEW.status IN ('AVAILABLE', 'DISCARDED'))
    OR (OLD.status = 'AVAILABLE' AND NEW.status IN ('RESERVED', 'EXPIRED', 'DISCARDED'))
    OR (OLD.status = 'RESERVED' AND NEW.status IN ('AVAILABLE', 'DISPATCHED', 'EXPIRED', 'DISCARDED'))
    OR (OLD.status = 'DISPATCHED' AND NEW.status IN ('TRANSFUSED', 'QUARANTINE'))
  ) THEN
    RAISE EXCEPTION 'illegal blood unit status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'ck_blood_unit_status_transition';
  END IF;

  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION {{HOT}}.record_blood_unit_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  v_from_status common.unit_status_t;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_from_status := NULL;
  ELSE
    v_from_status := OLD.status;
  END IF;

  INSERT INTO {{HIST}}.unit_status_log (unit_id, from_status, to_status)
  VALUES (NEW.unit_id, v_from_status, NEW.status);

  INSERT INTO {{HOT}}.outbox (unit_id, event_type, payload)
  VALUES (
    NEW.unit_id,
    'UNIT_UPSERT',
    jsonb_build_object(
      'unit_id', NEW.unit_id,
      'blood_bank_id', NEW.blood_bank_id,
      'blood_group', NEW.blood_group,
      'rh_factor', NEW.rh_factor,
      'component_type', NEW.component_type,
      'volume_ml', NEW.volume_ml,
      'collected_on', NEW.collected_on,
      'expiry_date', NEW.expiry_date,
      'status', NEW.status
    )
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_blood_units_status_guard ON {{HOT}}.blood_units;
CREATE TRIGGER trg_blood_units_status_guard
BEFORE UPDATE OF status ON {{HOT}}.blood_units
FOR EACH ROW
EXECUTE FUNCTION {{HOT}}.enforce_blood_unit_status_transition();

DROP TRIGGER IF EXISTS trg_blood_units_status_outbox ON {{HOT}}.blood_units;
CREATE TRIGGER trg_blood_units_status_outbox
AFTER INSERT OR UPDATE OF status ON {{HOT}}.blood_units
FOR EACH ROW
EXECUTE FUNCTION {{HOT}}.record_blood_unit_status_change();