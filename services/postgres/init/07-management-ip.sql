ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS management_ip INET;
