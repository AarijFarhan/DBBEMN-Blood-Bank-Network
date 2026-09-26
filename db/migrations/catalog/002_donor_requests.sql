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
