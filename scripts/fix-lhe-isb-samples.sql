WITH picked AS (
  SELECT u.unit_id, u.blood_bank_id, u.blood_group, u.rh_factor,
         u.component_type, u.volume_ml, u.collected_on, u.expiry_date
  FROM lhe_hot.blood_units u
  WHERE u.status = 'AVAILABLE'
    AND u.expiry_date > CURRENT_DATE + 7
    AND NOT EXISTS (
      SELECT 1 FROM lhe_read.units_search s WHERE s.unit_id = u.unit_id
    )
  ORDER BY u.expiry_date, u.unit_id
  LIMIT GREATEST(0, 100 - (SELECT count(*) FROM lhe_read.units_search))
)
INSERT INTO lhe_read.units_search
  (unit_id, blood_bank_id, blood_group, rh_factor, component_type,
   volume_ml, collected_on, expiry_date)
SELECT unit_id, blood_bank_id, blood_group, rh_factor, component_type,
       volume_ml, collected_on, expiry_date
FROM picked
ON CONFLICT (unit_id) DO NOTHING;

WITH picked AS (
  SELECT u.unit_id, u.blood_group, u.rh_factor
  FROM lhe_hot.blood_units u
  WHERE u.status = 'RESERVED'
    AND u.expiry_date > CURRENT_DATE
    AND NOT EXISTS (
      SELECT 1 FROM lhe_hot.reservations r
      WHERE r.unit_id = u.unit_id
        AND r.status IN ('ACTIVE', 'DISPATCHED')
    )
  ORDER BY u.unit_id
  LIMIT GREATEST(0, 100 - (SELECT count(*) FROM lhe_hot.reservations))
),
numbered AS (
  SELECT p.*, row_number() OVER (ORDER BY p.unit_id) AS rn
  FROM picked p
)
INSERT INTO lhe_hot.reservations
  (reservation_id, request_id, unit_id, hospital_id, hospital_city_code,
   patient_blood_group, patient_rh, urgency, status, reserved_at, hold_expires_at)
SELECT
  md5('sample:lhe:reservation:' || n.unit_id::text)::uuid,
  md5('sample:lhe:request:' || n.unit_id::text)::uuid,
  n.unit_id,
  '3f42bc78-ce5a-669b-a544-5853ccf054b8'::uuid,
  'LHE',
  n.blood_group,
  n.rh_factor,
  (ARRAY['CRITICAL', 'URGENT', 'ROUTINE'])[(1 + ((n.rn - 1) % 3))::int],
  'ACTIVE',
  now() - make_interval(mins => (n.rn % 30)::int),
  now() + interval '24 hours'
FROM numbered n
ON CONFLICT (reservation_id) DO NOTHING;

WITH picked AS (
  SELECT u.unit_id, u.blood_bank_id, u.blood_group, u.rh_factor,
         u.component_type, u.volume_ml, u.collected_on, u.expiry_date
  FROM isb_hot.blood_units u
  WHERE u.status = 'AVAILABLE'
    AND u.expiry_date > CURRENT_DATE + 7
    AND NOT EXISTS (
      SELECT 1 FROM isb_read.units_search s WHERE s.unit_id = u.unit_id
    )
  ORDER BY u.expiry_date, u.unit_id
  LIMIT GREATEST(0, 100 - (SELECT count(*) FROM isb_read.units_search))
)
INSERT INTO isb_read.units_search
  (unit_id, blood_bank_id, blood_group, rh_factor, component_type,
   volume_ml, collected_on, expiry_date)
SELECT unit_id, blood_bank_id, blood_group, rh_factor, component_type,
       volume_ml, collected_on, expiry_date
FROM picked
ON CONFLICT (unit_id) DO NOTHING;

WITH picked AS (
  SELECT u.unit_id, u.blood_group, u.rh_factor
  FROM isb_hot.blood_units u
  WHERE u.status = 'RESERVED'
    AND u.expiry_date > CURRENT_DATE
    AND NOT EXISTS (
      SELECT 1 FROM isb_hot.reservations r
      WHERE r.unit_id = u.unit_id
        AND r.status IN ('ACTIVE', 'DISPATCHED')
    )
  ORDER BY u.unit_id
  LIMIT GREATEST(0, 100 - (SELECT count(*) FROM isb_hot.reservations))
),
numbered AS (
  SELECT p.*, row_number() OVER (ORDER BY p.unit_id) AS rn
  FROM picked p
)
INSERT INTO isb_hot.reservations
  (reservation_id, request_id, unit_id, hospital_id, hospital_city_code,
   patient_blood_group, patient_rh, urgency, status, reserved_at, hold_expires_at)
SELECT
  md5('sample:isb:reservation:' || n.unit_id::text)::uuid,
  md5('sample:isb:request:' || n.unit_id::text)::uuid,
  n.unit_id,
  '8fed42dc-f8f7-e048-2ab5-70879e3ea461'::uuid,
  'ISB',
  n.blood_group,
  n.rh_factor,
  (ARRAY['CRITICAL', 'URGENT', 'ROUTINE'])[(1 + ((n.rn - 1) % 3))::int],
  'ACTIVE',
  now() - make_interval(mins => (n.rn % 30)::int),
  now() + interval '24 hours'
FROM numbered n
ON CONFLICT (reservation_id) DO NOTHING;
