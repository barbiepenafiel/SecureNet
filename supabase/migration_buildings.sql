-- ─────────────────────────────────────────────────────────────
-- Buildings list (Settings → Manage → Buildings)
-- Run once in the Supabase SQL Editor. Safe to run more than once.
--
-- The building names shown in every "Building" / "Location" dropdown.
-- Network Admins add, rename and delete them in Settings; a rename also
-- updates the devices, floor plans, rooms and users that use the old name
-- (done by the server, /api/buildings).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS buildings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS buildings_name_key ON buildings (lower(name));

-- Start with the names the dashboard used so far, and every location already in use
INSERT INTO buildings (name)
SELECT DISTINCT n FROM (
  SELECT unnest(ARRAY['Building A', 'Building B', 'Building C', 'Data Center', 'Library', 'Admin Building']) AS n
  UNION SELECT location FROM devices
) s
WHERE n IS NOT NULL AND btrim(n) <> '' AND n <> 'Unassigned'
  AND NOT EXISTS (SELECT 1 FROM buildings b WHERE lower(b.name) = lower(s.n));

DO $$
BEGIN
  IF to_regclass('public.floor_plans') IS NOT NULL THEN
    INSERT INTO buildings (name)
    SELECT DISTINCT building FROM floor_plans p
    WHERE NOT EXISTS (SELECT 1 FROM buildings b WHERE lower(b.name) = lower(p.building));
  END IF;
END $$;

-- Everyone signed in can read the list; changes go through /api/buildings
-- (Network Admin only, server-side) — no write policy on purpose.
ALTER TABLE buildings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS buildings_read ON buildings;
CREATE POLICY buildings_read ON buildings FOR SELECT TO authenticated USING (true);

-- Live updates (a rename shows in open dropdowns right away)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE buildings;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
