-- ─────────────────────────────────────────────────────────────
-- Floor plans for any building (Settings → Manage → Floor plans)
-- Run once in the Supabase SQL Editor. Safe to run more than once.
--
-- A Network Admin uploads a drawing (PNG / JPG / WebP) for a building and
-- floor, then places room names on it. Devices whose location is that
-- building can be assigned to its rooms and appear on the Floor Plan page.
-- The IC Building's two built-in drawings keep working (rooms with no plan).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS floor_plans (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building    TEXT NOT NULL,              -- matches devices.location
  floor       INTEGER NOT NULL CHECK (floor BETWEEN 1 AND 99),
  image_path  TEXT NOT NULL,              -- object in the floor-plans storage bucket
  width       INTEGER NOT NULL CHECK (width > 0),   -- image size in pixels (room positions use it)
  height      INTEGER NOT NULL CHECK (height > 0),
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (building, floor)
);

-- Rooms: any floor number; a room on an uploaded plan points to it
ALTER TABLE floor_rooms DROP CONSTRAINT IF EXISTS floor_rooms_floor_check;
ALTER TABLE floor_rooms ADD CONSTRAINT floor_rooms_floor_check CHECK (floor BETWEEN 1 AND 99);
ALTER TABLE floor_rooms ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES floor_plans(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS floor_rooms_plan_id_idx ON floor_rooms(plan_id);

-- Everyone signed in can see plans; only Network Admins can change them
ALTER TABLE floor_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS floor_plans_read  ON floor_plans;
DROP POLICY IF EXISTS floor_plans_write ON floor_plans;
CREATE POLICY floor_plans_read  ON floor_plans FOR SELECT TO authenticated USING (true);
CREATE POLICY floor_plans_write ON floor_plans FOR ALL    TO authenticated
  USING (is_net_admin()) WITH CHECK (is_net_admin());

-- Live updates (a new plan appears on open pages)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE floor_plans;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Image storage ───────────────────────────────────────────────────────
-- Public read (the drawings are shown on the dashboard); only Network
-- Admins can upload, replace or delete. Images only, up to 10 MB.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('floor-plans', 'floor-plans', true, 10485760, ARRAY['image/png', 'image/jpeg', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 10485760,
  allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp'];

DROP POLICY IF EXISTS floor_plans_upload ON storage.objects;
DROP POLICY IF EXISTS floor_plans_change ON storage.objects;
DROP POLICY IF EXISTS floor_plans_remove ON storage.objects;
CREATE POLICY floor_plans_upload ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'floor-plans' AND public.is_net_admin());
CREATE POLICY floor_plans_change ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'floor-plans' AND public.is_net_admin());
CREATE POLICY floor_plans_remove ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'floor-plans' AND public.is_net_admin());

NOTIFY pgrst, 'reload schema';
