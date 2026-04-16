-- Migration: add customers table and link profiles to customers.
-- Run manually against an existing deployment:
--   docker compose exec postgres psql -U ztp -d ztp -f /docker-entrypoint-initdb.d/03-customers.sql

CREATE TABLE IF NOT EXISTS customers (
    id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(128) UNIQUE NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE device_profiles
    ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_customer ON device_profiles(customer_id);
