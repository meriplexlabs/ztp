-- Add firmware tracking columns to devices
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS firmware_version    TEXT,
    ADD COLUMN IF NOT EXISTS firmware_checked_at TIMESTAMPTZ;
