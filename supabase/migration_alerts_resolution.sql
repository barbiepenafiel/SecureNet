-- Run in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/aslcrxdaochnzxernnqx/sql/new

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_at    TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_by    TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolution_notes TEXT;
