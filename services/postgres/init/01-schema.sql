-- ZTP Server Database Schema
-- Run order: 01-schema.sql → 02-seed.sql

-- Enable pgcrypto for password hashing (used by seed)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Users (local auth + OIDC account linking) ────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username      VARCHAR(64)  UNIQUE NOT NULL,
    email         VARCHAR(255) UNIQUE,
    password_hash VARCHAR(255),           -- NULL if OIDC-only account
    role          VARCHAR(32)  NOT NULL DEFAULT 'viewer', -- admin | editor | viewer
    oidc_sub      VARCHAR(255) UNIQUE,    -- Azure AD object ID
    active        BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_oidc_sub ON users(oidc_sub) WHERE oidc_sub IS NOT NULL;

-- ─── Config Templates ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config_templates (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(128) NOT NULL,           -- e.g. "Cisco IOS-XE Baseline"
    vendor      VARCHAR(64)  NOT NULL,           -- cisco, aruba, juniper, extreme, fortinet
    os_type     VARCHAR(64)  NOT NULL,           -- ios-xe, ios, aos-cx, aos, junos-ex, exos, fortiswitch
    file_path   VARCHAR(255),                    -- relative path in configs/ (for file-backed templates)
    content     TEXT,                            -- inline content (NULL if file-backed)
    variables   JSONB        NOT NULL DEFAULT '[]', -- array of {name, description, required, default}
    created_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_template_source CHECK (file_path IS NOT NULL OR content IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_templates_vendor    ON config_templates(vendor);
CREATE INDEX IF NOT EXISTS idx_templates_os_type   ON config_templates(os_type);

-- ─── Device Profiles ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_profiles (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(128) UNIQUE NOT NULL,
    description TEXT,
    template_id UUID        REFERENCES config_templates(id) ON DELETE RESTRICT,
    variables   JSONB       NOT NULL DEFAULT '{}',  -- {hostname_prefix, domain, snmp_auth_pass, ...}
    created_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Devices ──────────────────────────────────────────────────────────────────
CREATE TYPE device_status AS ENUM (
    'unknown',
    'discovered',
    'provisioning',
    'provisioned',
    'failed',
    'ignored'
);

CREATE TABLE IF NOT EXISTS devices (
    id           UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    mac          MACADDR       UNIQUE,
    serial       VARCHAR(128)  UNIQUE,
    vendor_class VARCHAR(255),                     -- DHCP option 60 value
    hostname     VARCHAR(253),
    description  TEXT,
    status       device_status NOT NULL DEFAULT 'unknown',
    profile_id   UUID          REFERENCES device_profiles(id) ON DELETE SET NULL,
    variables    JSONB         NOT NULL DEFAULT '{}',  -- device-level variable overrides
    last_seen    TIMESTAMPTZ,
    provisioned_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_device_identity CHECK (mac IS NOT NULL OR serial IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_devices_mac          ON devices(mac)    WHERE mac IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_devices_serial       ON devices(serial) WHERE serial IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_devices_vendor_class ON devices(vendor_class);
CREATE INDEX IF NOT EXISTS idx_devices_status       ON devices(status);

-- ─── DHCP Reservations (static assignments, fed to Kea) ───────────────────────
CREATE TABLE IF NOT EXISTS dhcp_reservations (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id   UUID        REFERENCES devices(id) ON DELETE CASCADE,
    mac         MACADDR     UNIQUE NOT NULL,
    ip_address  INET        UNIQUE NOT NULL,
    hostname    VARCHAR(253),
    options     JSONB       NOT NULL DEFAULT '{}',  -- extra DHCP options {66: "tftp-ip", 67: "boot.cfg"}
    active      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dhcp_reservations_mac ON dhcp_reservations(mac);
CREATE INDEX IF NOT EXISTS idx_dhcp_reservations_ip  ON dhcp_reservations(ip_address);

-- ─── Syslog Events ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS syslog_events (
    id          BIGSERIAL   PRIMARY KEY,
    device_id   UUID        REFERENCES devices(id) ON DELETE SET NULL,
    source_ip   INET        NOT NULL,
    severity    SMALLINT    NOT NULL,   -- 0-7 per RFC 5424
    facility    SMALLINT    NOT NULL,   -- 0-23 per RFC 5424
    hostname    VARCHAR(253),
    app_name    VARCHAR(48),
    proc_id     VARCHAR(128),
    msg_id      VARCHAR(32),
    message     TEXT        NOT NULL,
    raw         TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_syslog_device_id   ON syslog_events(device_id);
CREATE INDEX IF NOT EXISTS idx_syslog_source_ip   ON syslog_events(source_ip);
CREATE INDEX IF NOT EXISTS idx_syslog_received_at ON syslog_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_syslog_severity    ON syslog_events(severity);

-- ─── Audit Log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL   PRIMARY KEY,
    user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
    username    VARCHAR(64),            -- denormalized for display after user deletion
    action      VARCHAR(64)  NOT NULL,  -- created, updated, deleted, login, logout, config_fetched
    entity_type VARCHAR(64),            -- device, template, profile, user, dhcp_reservation
    entity_id   UUID,
    payload     JSONB       NOT NULL DEFAULT '{}',
    ip_address  INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user_id    ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity     ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log(created_at DESC);

-- ─── Settings (UI overrides env vars) ────────────────────────────────────────
-- value = NULL means "use the env var / compiled default"
CREATE TABLE IF NOT EXISTS settings (
    key         VARCHAR(100) PRIMARY KEY,
    value       TEXT,
    label       VARCHAR(128) NOT NULL,
    description TEXT,
    category    VARCHAR(64)  NOT NULL DEFAULT 'general',
    updated_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed the known settings keys (values start as NULL → use env/default)
INSERT INTO settings (key, label, description, category) VALUES
    ('ztp.domain',           'ZTP Domain',              'Default domain appended to device hostnames (e.g. corp.local)',           'ztp'),
    ('ztp.tftp_server',      'TFTP Server',             'IP or hostname of the TFTP server sent to devices via DHCP option 66',   'ztp'),
    ('ztp.api_base_url',     'API Base URL',            'Externally reachable URL for the ZTP config endpoint (HTTP)',            'ztp'),
    ('snmp.auth_protocol',   'SNMP Auth Protocol',      'Default SNMPv3 authentication protocol (SHA / MD5)',                    'snmp'),
    ('snmp.priv_protocol',   'SNMP Privacy Protocol',   'Default SNMPv3 privacy/encryption protocol (AES / DES)',                'snmp'),
    ('snmp.location',        'SNMP Location',           'Default sysLocation OID value injected into device configs',            'snmp'),
    ('kea.ctrl_agent_url',   'Kea Control Agent URL',   'Internal URL for the Kea DHCP control agent REST API',                  'dhcp'),
    ('kea.dhcp_interface',   'DHCP Interface',          'Network interface Kea listens on for DHCP broadcasts',                  'dhcp')
ON CONFLICT (key) DO NOTHING;

-- ─── Updated-at trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'users', 'config_templates', 'device_profiles',
        'devices', 'dhcp_reservations'
    ] LOOP
        EXECUTE format(
            'CREATE OR REPLACE TRIGGER trg_%s_updated_at
             BEFORE UPDATE ON %s
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
            tbl, tbl
        );
    END LOOP;
END;
$$;
