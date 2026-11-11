-- ─────────────────────────────────────────────────────────────
-- Floor plan rooms (Settings → Manage)
-- Run once in the Supabase SQL Editor. Safe to run more than once.
--
-- Rooms used to be hardcoded. Now they live here so a Network Admin can
-- rename / add / move / delete them, and each device can be assigned to a
-- room (devices.room_id) instead of relying on its name.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS floor_rooms (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building   TEXT NOT NULL DEFAULT 'IC Building',
  floor      INTEGER NOT NULL CHECK (floor IN (1, 2)),
  label      TEXT NOT NULL,
  x          INTEGER NOT NULL,              -- room name position on the floor drawing
  y          INTEGER NOT NULL,
  vertical   BOOLEAN NOT NULL DEFAULT false, -- draw the name rotated (narrow rooms)
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE devices ADD COLUMN IF NOT EXISTS room_id UUID REFERENCES floor_rooms(id) ON DELETE SET NULL;

-- Current rooms (only added if the table is empty)
INSERT INTO floor_rooms (floor, label, x, y, vertical)
SELECT * FROM (VALUES
  (1, 'Faculty 1',          187, 122, false),
  (1, 'Accreditation Room', 477, 123, false),
  (1, 'Netlab',             750, 122, false),
  (1, 'Faculty 2',          165, 372, false),
  (1, 'Comlab 1',           595, 372, false),
  (2, 'MacLab',             195, 122, false),
  (2, 'AES',                475, 122, false),
  (2, 'GDA',                690, 122, false),
  (2, 'Faculty 3',          890, 250, true),
  (2, 'Server Room',        150, 371, false),
  (2, 'Comlab 2',           530, 372, false)
) AS v(floor, label, x, y, vertical)
WHERE NOT EXISTS (SELECT 1 FROM floor_rooms);

-- Everyone signed in can see rooms; only Network Admins can change them
ALTER TABLE floor_rooms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS floor_rooms_read  ON floor_rooms;
DROP POLICY IF EXISTS floor_rooms_write ON floor_rooms;
CREATE POLICY floor_rooms_read  ON floor_rooms FOR SELECT TO authenticated USING (true);
CREATE POLICY floor_rooms_write ON floor_rooms FOR ALL    TO authenticated
  USING (is_net_admin()) WITH CHECK (is_net_admin());

-- Live updates (renaming a room updates open floor plans)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE floor_rooms;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
