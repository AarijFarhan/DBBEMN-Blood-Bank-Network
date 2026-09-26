-- A donor call-out lives in the HOT schema of the DONOR's city shard, because
-- the donor who has to act on it is the one reading it. The requester may sit in
-- a different city, so requester identity is stored as a bare UUID pair rather
-- than a foreign key, matching how blood_units.blood_bank_id already works.
CREATE TABLE IF NOT EXISTS {{HOT}}.donor_requests (
  request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  donor_id UUID NOT NULL REFERENCES {{HIST}}.donors,
  requested_by_hospital_id UUID,
  requested_by_blood_bank_id UUID,
  patient_ref TEXT,
  required_blood_group common.blood_group_t NOT NULL,
  required_rh common.rh_t NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'ROUTINE'
    CHECK (urgency IN ('CRITICAL', 'URGENT', 'ROUTINE')),
  slots_requested INT NOT NULL DEFAULT 1 CHECK (slots_requested BETWEEN 1 AND 10),
  notes TEXT,
  status common.donor_request_status_t NOT NULL DEFAULT 'PENDING',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  response_notes TEXT,
  -- Why: a call-out has exactly one issuer, and the pair of nullable columns is
  -- how the issuer is identified. Enforce that here so no row is ambiguous.
  CONSTRAINT donor_requests_single_requester CHECK (
    (requested_by_hospital_id IS NOT NULL AND requested_by_blood_bank_id IS NULL)
    OR (requested_by_hospital_id IS NULL AND requested_by_blood_bank_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_donor_requests_donor
  ON {{HOT}}.donor_requests (donor_id, status);

CREATE INDEX IF NOT EXISTS idx_donor_requests_hospital
  ON {{HOT}}.donor_requests (requested_by_hospital_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_donor_requests_blood_bank
  ON {{HOT}}.donor_requests (requested_by_blood_bank_id, requested_at DESC);
