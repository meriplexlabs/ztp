-- Add target firmware version to device profiles
ALTER TABLE device_profiles
    ADD COLUMN IF NOT EXISTS firmware_version TEXT;
