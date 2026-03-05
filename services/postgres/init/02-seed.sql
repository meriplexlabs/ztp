-- ZTP Server - Seed Data
-- Creates a default admin user (username: admin, password: Admin1234!)
-- Change the password immediately after first login.

INSERT INTO users (username, email, password_hash, role)
VALUES (
    'admin',
    'admin@ztp.local',
    crypt('Admin1234!', gen_salt('bf', 12)),
    'admin'
)
ON CONFLICT (username) DO NOTHING;

-- ─── Seed file-backed config templates from configs/ directory ─────────────────

INSERT INTO config_templates (name, vendor, os_type, file_path, variables)
VALUES
    ('Cisco IOS Baseline',      'cisco',    'ios',           'cisco/ios.cfg',           '[]'),
    ('Cisco IOS-XE Baseline',   'cisco',    'ios-xe',        'cisco/ios-xe.cfg',        '[]'),
    ('Aruba AOS Baseline',      'aruba',    'aos',           'aruba/aos.cfg',            '[]'),
    ('Aruba AOS-CX Baseline',   'aruba',    'aos-cx',        'aruba/aos-cx.cfg',         '[]'),
    ('Extreme EXOS Baseline',   'extreme',  'exos',          'extreme/exos.cfg',         '[]'),
    ('Fortinet FortiSwitch',    'fortinet', 'fortiswitch',   'fortinet/fortiswitch.cfg', '[]'),
    ('Juniper EX (JunOS)',      'juniper',  'junos-ex',      'juniper/junos-ex.cfg',     '[]')
ON CONFLICT DO NOTHING;
