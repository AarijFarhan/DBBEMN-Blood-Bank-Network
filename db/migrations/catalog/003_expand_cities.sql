-- Expand the routing catalog from the original three cities to the full
-- ten-city topology. catalog.cities is the fixed catalog used to validate shard
-- keys, so a new node needs a row here before migrate can create its schemas.
--
-- Why a separate migration instead of editing 001: the migration registry only
-- re-applies a file when the objects it owns (schemas, tables, functions) are
-- missing, not when rows are. Editing 001's INSERT would leave already-migrated
-- databases without the new cities forever.

INSERT INTO catalog.cities (city_code, name, latitude, longitude)
VALUES
  ('RWP', 'Rawalpindi', 33.565100, 73.016900),
  ('FSD', 'Faisalabad', 31.418000, 73.079000),
  ('MUL', 'Multan', 30.157500, 71.524900),
  ('PEW', 'Peshawar', 34.015100, 71.580100),
  ('QUE', 'Quetta', 30.179800, 66.975000),
  ('HYD', 'Hyderabad', 25.396000, 68.357800),
  ('GUJ', 'Gujranwala', 32.187700, 74.194500)
ON CONFLICT (city_code) DO NOTHING;

INSERT INTO catalog.chaos_flags (city_code)
SELECT city_code FROM catalog.cities
WHERE city_code IN ('RWP', 'FSD', 'MUL', 'PEW', 'QUE', 'HYD', 'GUJ')
ON CONFLICT (city_code) DO NOTHING;
