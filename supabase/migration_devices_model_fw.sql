-- Add model and firmware columns to devices table
ALTER TABLE devices ADD COLUMN IF NOT EXISTS model    TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS firmware TEXT;
