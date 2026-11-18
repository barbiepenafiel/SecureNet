-- ─────────────────────────────────────────────────────────────
-- Floor plan designer (Settings → Manage → Floor plans → Designer)
-- Run once in the Supabase SQL Editor (safe to run more than once).
--
-- One drawing per building floor: rooms, walls, doors, labels, shapes and
-- device markers, stored as JSON in `doc`. Device markers keep only the
-- device's id (devices.id) — no device is copied; name, IP and status are
-- always read live from the devices table.
-- Everyone signed in can view the designs; only Network Admins change them.
-- Existing uploaded plans (floor_plans / floor_rooms) are not changed and
-- can be used as a background image of a design.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS floor_designs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building    TEXT NOT NULL,                       -- matches buildings.name / devices.location
  floor_no    INTEGER NOT NULL CHECK (floor_no BETWEEN -10 AND 200),   -- order (0 = ground floor)
  floor_name  TEXT NOT NULL CHECK (length(btrim(floor_name)) BETWEEN 1 AND 60),
  doc         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- canvas size, background, elements
  version     INTEGER NOT NULL DEFAULT 1,          -- bumped on every save (stops two admins overwriting each other)
  updated_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (building, floor_no)
);
CREATE INDEX IF NOT EXISTS floor_designs_building_idx ON floor_designs (building, floor_no);

ALTER TABLE floor_designs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS floor_designs_read  ON floor_designs;
DROP POLICY IF EXISTS floor_designs_write ON floor_designs;
CREATE POLICY floor_designs_read  ON floor_designs FOR SELECT TO authenticated USING (true);
CREATE POLICY floor_designs_write ON floor_designs FOR ALL    TO authenticated
  USING (is_net_admin()) WITH CHECK (is_net_admin());

-- Renaming a building (Settings → Manage → Buildings) keeps its designs with it
CREATE OR REPLACE FUNCTION floor_designs_follow_building()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE floor_designs SET building = NEW.name WHERE lower(building) = lower(OLD.name);
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF to_regclass('public.buildings') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS floor_designs_follow_building ON buildings;
    CREATE TRIGGER floor_designs_follow_building AFTER UPDATE OF name ON buildings
      FOR EACH ROW EXECUTE FUNCTION floor_designs_follow_building();
  END IF;
END $$;

-- Live updates (another admin's save shows up; view mode refreshes)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE floor_designs;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
