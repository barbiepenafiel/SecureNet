-- ─────────────────────────────────────────────────────────────
-- Role-based access: Network Admin + IT Staff
-- Run this once in the Supabase SQL editor.
-- ─────────────────────────────────────────────────────────────

-- One profile row per login account (auth.users)
CREATE TABLE IF NOT EXISTS profiles (
  id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email           text NOT NULL,
  full_name       text NOT NULL DEFAULT '',
  role            text NOT NULL DEFAULT 'it_staff'
                  CHECK (role IN ('net_admin', 'it_staff')),
  building_access text NOT NULL DEFAULT 'All sites',
  last_login      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Create a profile automatically when an account is created.
-- The very first account becomes Network Admin; everyone after that
-- starts as IT Staff unless a role is passed in the user metadata.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  new_role text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles) THEN
    new_role := 'net_admin';
  ELSE
    new_role := COALESCE(NEW.raw_user_meta_data->>'role', 'it_staff');
    IF new_role NOT IN ('net_admin', 'it_staff') THEN
      new_role := 'it_staff';
    END IF;
  END IF;

  INSERT INTO profiles (id, email, full_name, role, building_access)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    new_role,
    COALESCE(NEW.raw_user_meta_data->>'building_access', 'All sites')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Backfill profiles for accounts that already exist
INSERT INTO profiles (id, email, full_name, role)
SELECT u.id, u.email, split_part(u.email, '@', 1), 'it_staff'
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- Helper used by policies
CREATE OR REPLACE FUNCTION is_net_admin()
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'net_admin');
$$;

-- Row-level security on profiles:
--   everyone signed in can read their own profile, admins can read all.
--   Only the server (service role) writes, through /api/users.
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_select ON profiles;
CREATE POLICY profiles_select ON profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR is_net_admin());

-- ─────────────────────────────────────────────────────────────
-- Make a specific account Network Admin (edit the email if needed)
-- ─────────────────────────────────────────────────────────────
UPDATE profiles SET role = 'net_admin', full_name = 'Admin'
WHERE email = 'admin@gmail.com';
