# ZTP Server — Complete System Overview

This document is a full engineering handoff. It covers every service, every meaningful code file, every database table, and every non-obvious design decision. Written for an engineer maintaining this without AI assistance.

---

## What This System Does

Zero Touch Provisioning (ZTP) automatically configures network switches and routers the moment they boot for the first time. A device powers on, asks DHCP for an IP, gets pointed at a TFTP server (for older protocols) or an HTTP endpoint (for modern ones), fetches a rendered Jinja2 config, applies it, and reports back via syslog. The dashboard gives operators visibility into every device, template, profile, and event — and lets them push config changes, manage DHCP reservations, and monitor the fleet.

---

## Infrastructure

### Services (Docker Compose)

All services are defined in `docker-compose.yml` at the repo root. In production they are also described as Kubernetes manifests under `k8s/`.

| Service | Image / Language | Port(s) | Purpose |
|---------|-----------------|---------|---------|
| `postgres` | PostgreSQL 16 | 5432 | Single source of truth for all persistent state |
| `kea` | ISC Kea DHCP4 + Control Agent | 67/udp (DHCP), 8000 (API) | Hands out IP addresses, sends TFTP/boot options |
| `bind` | BIND9 | 53 | Internal DNS — zone `ztp.local` |
| `tftp` | tftpd-hpa | 69/udp | Serves boot files to devices that use TFTP (older Aruba, HP ProCurve) |
| `renderer` | Python FastAPI + Jinja2 | 8001 | Renders Jinja2 templates against device variable sets |
| `syslog` | Go | 514/udp+tcp | Receives syslog from devices, persists to DB, updates device status |
| `api` | Go | 8080 | REST API + ZTP config endpoints + auth |
| `ui` | Nginx serving Vite/React build | 3000 (nginx) | Web dashboard |

### Network Architecture

The UI container runs Nginx. Nginx proxies all `/api/`, `/juniper/`, `/aruba/`, and `/pnp/` paths to `http://api:8080`. Static assets (the React app) are served directly by Nginx. This means there is only one external port (3000) for both UI and API — the UI container is the ingress point for human users.

Devices communicate directly with the API on port 8080 (not through the UI Nginx) because DHCP option 66/67 points them at the server's IP directly. Exception: Aruba/HP devices that use HTTP ZTP may reach through the Nginx proxy on port 80 if configured that way.

Kea DHCP runs in `host` network mode on Kubernetes (DaemonSet with `hostNetwork: true`) because DHCP broadcasts cannot be routed through the standard container network. On Docker Compose the same constraint applies.

---

## Database Schema

All schema lives in `services/postgres/init/`. Files are executed in filename order by PostgreSQL's Docker entrypoint on first container start. **Subsequent runs do not re-execute these files** — use `ALTER TABLE` migrations for schema changes on live instances.

### Init Files

| File | Purpose |
|------|---------|
| `01-schema.sql` | All tables, indexes, constraints, the `set_updated_at` trigger |
| `02-seed.sql` | Default admin user (admin / Admin1234!), default settings rows |
| `03-customers.sql` | Adds `customers` table and `customer_id` FK on `device_profiles` |
| `04-firmware.sql` | Adds `firmware_version`, `firmware_checked_at` to devices; `firmware_version` to profiles |
| `05-profile-firmware.sql` | Additional firmware-related indexes |
| `06-alerts.sql` | `alerts` table for offline/drift/failed notifications |
| `07-management-ip.sql` | Adds `management_ip inet` to devices (manually set by operators) |
| `08-git-settings.sql` | Inserts git integration settings keys; adds unique constraint on templates |
| `09-last-connection-ip.sql` | Adds `last_connection_ip inet` to devices (auto-set from ZTP connection source IP) |

### Key Tables

#### `devices`
The central table. Every network device that has been discovered or manually entered exists here.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | Internal identifier |
| `mac` | MACADDR | Unique. NULL allowed if serial is set |
| `serial` | VARCHAR | Unique. NULL allowed if MAC is set |
| `vendor_class` | VARCHAR | DHCP option 60 value — used for device classification |
| `hostname` | VARCHAR | Set from syslog or manually |
| `status` | ENUM | `unknown` → `discovered` → `provisioning` → `provisioned` / `failed` |
| `profile_id` | UUID FK | The device profile assigned to this device |
| `variables` | JSONB | Device-level variable overrides. Merged with profile variables at render time. Also stores `vlans` and `ports` arrays for per-device VLAN/port config |
| `management_ip` | INET | **Manually set by operator.** The device's real management IP. Used for SSH terminal, ping liveness |
| `last_connection_ip` | INET | **Auto-set by the ZTP server** when a device fetches its config (Juniper handler). Cleared/overwritten each fetch. Used as ping fallback when management_ip is not set |
| `last_seen` | TIMESTAMPTZ | Updated by: PnP polls, syslog receipt, ping success |
| `provisioned_at` | TIMESTAMPTZ | Set when syslog provisioning keywords are detected |

The constraint `chk_device_identity` enforces that at least one of `mac` or `serial` is always present.

#### `config_templates`
Jinja2 templates for device configuration.

| Column | Notes |
|--------|-------|
| `vendor` | cisco, aruba, juniper, extreme, fortinet |
| `os_type` | ios-xe, junos-ex, aos-cx, etc. |
| `file_path` | Path relative to `configs/` volume. NULL if content is inline |
| `content` | Full template text. NULL if file-backed |
| `variables` | JSONB array of `{name, description, required, default}` — metadata only, not the actual values |

The `CONSTRAINT chk_template_source` ensures exactly one of `file_path` or `content` is set.

A unique constraint `uq_template_vendor_ostype_name` on `(vendor, os_type, name)` enables the git sync upsert to work correctly.

#### `device_profiles`
Profiles are the bridge between templates and devices. A profile holds a template reference plus a set of default variable values (including VLAN and port maps). Many devices can share one profile.

| Column | Notes |
|--------|-------|
| `template_id` | FK to `config_templates`. RESTRICT on delete — can't delete a template in use |
| `variables` | JSONB dict. Keys match template variable names. Special keys: `vlans` (array of `{id, name, description}`) and `ports` (array of `{port, native_vlan, allowed_vlans?, description}`) |
| `customer_id` | FK to `customers`. Optional grouping |
| `firmware_version` | Target firmware version. Used for drift alerting |

#### `syslog_events`
Every syslog message received. High volume — expect millions of rows over time. Consider a retention policy (e.g., `DELETE FROM syslog_events WHERE received_at < NOW() - INTERVAL '90 days'`).

| Column | Notes |
|--------|-------|
| `device_id` | FK to devices. Populated automatically at insert time by matching `hostname` field against device `hostname` or `serial`, then `management_ip`, then DHCP reservation |
| `source_ip` | The IP the packet arrived from. May be a NAT gateway, not the device itself |
| `severity` | 0–7 per RFC 5424 (0=Emergency, 7=Debug) |
| `hostname` | The hostname field from the syslog message itself — used for device matching |

#### `settings`
Key-value store for operator-configurable settings. All keys are seeded on first run with NULL values (meaning "use environment variable or compiled default"). The UI Settings page allows updating values. `GetSettingValue()` in the API reads from this table.

Settings are grouped by category: `ztp`, `snmp`, `dhcp`, `git`.

#### `alerts`
Generated by the background alerting poller. Types: `offline`, `firmware_drift`, `failed`. The UI shows unresolved alerts.

#### `dhcp_reservations`
Static DHCP entries fed to Kea. Each row ties a MAC to a fixed IP. Also used as a fallback for matching syslog source IPs to devices.

---

## Services Deep Dive

### 1. PostgreSQL (`services/postgres/`)

Standard PostgreSQL 16. The only configuration beyond the init scripts is the `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` environment variables. All services connect using these credentials.

### 2. Kea DHCP (`services/kea/`)

ISC Kea handles DHCP4. It classifies devices by DHCP option 60 (vendor-class-identifier) and sends different boot parameters per class. The config lives in `services/kea/config/kea-dhcp4.json`. The Kea Control Agent runs alongside on port 8000 and exposes a REST API that the ZTP API uses to read lease data.

Key classifications in `kea-dhcp4.json`:
- `ciscoSystems` (option 60 starts with "ciscoSystems") → Cisco PnP
- `ArubaAP` → Aruba access points
- Various HP/Aruba switch strings → TFTP boot
- Default → generic DHCP

Option 66 (TFTP server IP) and option 67 (boot filename) direct older devices to the TFTP service.

### 3. BIND9 (`services/bind/`)

Internal DNS resolver for `ztp.local`. Devices can be given hostnames in this zone by adding records to the BIND config. The ZTP domain is configurable via the `ztp.domain` setting.

### 4. TFTP (`services/tftp/`)

tftpd-hpa serving files from `services/tftp/tftpboot/`. HP ProCurve and similar devices that cannot do HTTP ZTP download their config file via TFTP. The boot filename (sent via DHCP option 67) must match a file in this directory.

### 5. Renderer (`services/renderer/`)

Python FastAPI service. Two endpoints:

- `POST /render` — accepts `{template_name: "..."}` or `{content: "..."}` plus `{variables: {...}}`, renders the Jinja2 template, returns rendered text
- `POST /variables` — same input but just extracts all variable names used in the template (using Jinja2's `meta.find_undeclared_variables`)
- `GET /templates` — lists available template files in the `configs/` volume

The renderer has no authentication. It is only reachable internally (not exposed externally). The Go API calls it synchronously when a device requests its config.

Templates live in `configs/{vendor}/{os_type}/{name}.cfg` or `configs/{vendor}/{name}.cfg`.

### 6. Syslog Receiver (`services/syslog/main.go`)

A single Go file. Listens on both UDP and TCP port 514. Parses RFC 5424 and RFC 3164 syslog messages.

**On every message received:**
1. Parse the message into `SyslogMessage` struct
2. Call `resolveDeviceID()` — attempts to find the matching device by:
   - Matching syslog `hostname` field against device `hostname` column (case-insensitive)
   - Matching syslog `hostname` field against device `serial` column (Juniper sends its serial as hostname)
   - Matching source IP against device `management_ip`
   - Matching source IP against `dhcp_reservations.ip_address`
3. `insertEvent()` — write to `syslog_events` with the resolved `device_id` (NULL if unmatched)
4. `updateDeviceLastSeen()` — if device_id resolved, UPDATE that device's `last_seen`; otherwise fall back to IP-based matching
5. If `isProvisioningComplete()` returns true (message contains known provisioning keywords), call `updateDeviceProvisioned()` to set device status to `provisioned`

**Provisioning keywords** (in `provisionedKeywords` slice):
- "ZTP provisioned"
- "ztp-provision complete"
- "Autoinstall complete"
- "Auto-Install complete"
- "configuration applied"

If a device sends syslog through NAT, the source IP will be the NAT gateway. The `hostname` field in the syslog message is the only reliable way to match NAT'd devices to their DB record. This is why `hostname` and `serial` matching take priority over IP matching.

---

## Go API (`services/dashboard/api/`)

### Entry Point: `cmd/api/main.go`

Starts the server. Key things it does in order:
1. Loads config from environment via `config.Load()`
2. Connects to PostgreSQL via `db.Connect()`
3. Starts `discovery.RunLeasePoller()` in a goroutine — polls Kea leases every 30s
4. Starts `alerting.Run()` in a goroutine — evaluates alert conditions every 60s
5. Optionally initialises OIDC provider (Azure AD)
6. Creates all handlers, registers all routes
7. Starts HTTP server on `0.0.0.0:8080`
8. Blocks on `ctx.Done()` (SIGINT/SIGTERM), then graceful shutdown with 10s timeout

**Route structure:**
- Unauthenticated: `/health`, `/api/v1/auth/*`, `/api/v1/config/{identifier}`, `/juniper/{serial}/config`, `/aruba/config`, `/pnp/*`, `/api/v1/devices/{id}/terminal*`
- JWT-protected: everything else under `/api/v1/`

### Package: `internal/config`

`config.go` — reads environment variables, validates required ones (`JWT_SECRET`), returns a `Config` struct. `DBConnString()` builds the pgx connection string.

### Package: `internal/models`

`models.go` — Go structs that mirror the DB tables, with JSON tags for the API. Key types:
- `Device` — includes `ManagementIP`, `LastConnectionIP`, `LastSeen`
- `ConfigTemplate` — `Content *string` is nil for file-backed templates
- `DeviceProfile` — `Variables map[string]any` holds everything including vlans/ports arrays
- `SyslogEvent` — `DeviceID *uuid.UUID` is nil when unmatched

### Package: `internal/db`

`db.go` — all PostgreSQL query functions. Never runs raw SQL outside this package (except handlers that need custom queries). Key functions:

| Function | Purpose |
|----------|---------|
| `Connect()` | Opens pgx connection pool |
| `ListDevices()` | SELECT all device columns including `last_connection_ip` |
| `GetDevice()` | SELECT by UUID |
| `GetDeviceByIdentifier()` | Try serial first, fall back to MAC — used by ZTP config endpoint |
| `CreateDevice()` / `UpdateDevice()` | UPSERT device records |
| `ListTemplates()` / `GetTemplate()` / `CreateTemplate()` / `UpdateTemplate()` | Template CRUD |
| `UpsertTemplate()` | INSERT ON CONFLICT (vendor, os_type, name) — used by git sync |
| `ListProfiles()` / `GetProfile()` / `CreateProfile()` / `UpdateProfile()` | Profile CRUD |
| `ListEvents()` | Syslog events with optional device filter. Handles three filter modes: specific device (UUID), "unknown" (device_id IS NULL), or all |
| `GetSettingValue()` | SELECT value FROM settings WHERE key = $1. Returns "" if not set |
| `UpsertTemplate()` | Git sync upsert |

The `scanDevice()` helper is used by all device query functions to scan a row into a `models.Device`. It scans columns in the exact order they appear in the SELECT. **If you add a column to devices, you must add it to every SELECT and to the `scanDevice()` Scan() call.**

### Package: `internal/auth`

`auth.go` — handles both local (bcrypt password) and OIDC (Azure AD) authentication.

- `LocalLogin()` — compares submitted password against bcrypt hash, issues JWT
- `OIDCRedirect()` — redirects browser to Azure AD login
- `OIDCCallback()` — handles Azure AD callback, exchanges code for tokens, creates/updates user record, issues JWT
- `JWTMiddleware()` — validates JWT in `Authorization: Bearer` header or `token` cookie; injects claims into context
- `RequireRole()` — middleware that checks `role` claim in JWT against required role

JWT tokens are HS256, signed with `JWT_SECRET`. They contain `user_id`, `username`, `role`, and `exp` claims. Expiry defaults to 24h.

### Package: `internal/handlers`

One file per logical area. All handlers receive a `*pgxpool.Pool` and optional other dependencies via their constructor.

#### `handlers/helpers.go`
Shared utilities used by all handlers:
- `writeJSON()` — sets Content-Type, marshals response
- `writeError()` — writes `{"error": "..."}` with given status code
- `decodeJSON()` — decodes request body, returns error on failure
- `queryInt()` — reads an integer query parameter with a default

#### `handlers/middleware.go`
- `JWTMiddleware()` — validates JWT, rejects with 401 if invalid
- `RequireRole()` — returns 403 if authenticated user's role doesn't match

#### `handlers/auth.go`
Handles login, logout, OIDC flow, `/me` endpoint (returns current user), `/users` list (admin only).

#### `handlers/devices.go`
Standard CRUD plus:
- `ZTPConfig` — the endpoint devices call to get their config. Looks up device by MAC or serial, merges device variables with profile variables, calls renderer, returns rendered config. Also triggers `go gitops.CommitConfig()` after RunningConfig pulls and PushConfig.
- `RunningConfig` — SSHes to the device, fetches running config, commits to git backup repo in background
- `PushConfig` — renders config and SSHes it to the device
- `FirmwareVersion` — SSHes to device and parses firmware version, stores in DB

#### `handlers/pnp.go`
Cisco PnP protocol handler. Cisco devices call these endpoints on boot.

- `Hello` — responds to the initial PnP HELLO (GET/POST/PUT). Looks up device by UDI (serial), auto-registers if not seen, updates `last_seen`
- `WorkRequest` — the main PnP loop. Device POSTs here repeatedly. If the device has a profile, returns a config-apply job; otherwise returns a BYE. Updates `last_seen` on every call. This is why Cisco devices have very fresh `last_seen` — they poll every ~5 seconds.

The PnP XML responses are hand-crafted strings. Cisco PnP uses a correlator ID to track job state across the multi-step work request/response flow.

#### `handlers/juniper.go`
Juniper ZTP handler. Juniper EX/QFX devices on boot call `GET /juniper/{serial}/config`.

Key behaviour:
1. Extract serial from URL path
2. Look up device by serial, auto-register if not found
3. Backfill MAC from query parameter if device doesn't have one
4. Set `last_connection_ip` from the HTTP request source IP (used for ping liveness)
5. If no profile assigned: return 404 to trigger retry
6. If profile assigned: call renderer, return rendered config, set status to `provisioning`

The `last_connection_ip` is important: it's the only way the ping poller can reach Juniper devices that aren't in DHCP reservations and don't have `management_ip` set.

#### `handlers/aruba.go`
Aruba/HP ZTP handler. Aruba devices call `GET /aruba/config` with MAC in a query parameter. Similar flow to Juniper but uses MAC for lookup.

#### `handlers/templates.go`
Template CRUD. After Create and Update, calls `go gitops.CommitTemplate()` to back up to the template git repo. The `Variables` endpoint proxies to the renderer's `/variables` endpoint to extract Jinja2 variable names from template content.

#### `handlers/profiles.go`
Profile CRUD. After Create and Update, calls `go gitops.CommitProfile()` to back up to the template git repo.

#### `handlers/events.go`
- `List` — returns syslog events with optional `device_id` or `unknown` filter
- `Sources` — returns distinct source IPs from syslog_events with device label (used by the UI dropdown)

#### `handlers/gitops.go`
- `SyncTemplates` — POST `/api/v1/git/sync-templates`. Clones the template repo, walks `.cfg` and `.j2` files, upserts each into the DB. Returns count of synced templates.

#### `handlers/kea.go`
Proxy to the Kea Control Agent REST API. Reads DHCP leases and statistics.

#### `handlers/terminal.go`
WebSocket SSH terminal. Opens an SSH connection to the device's `management_ip` and proxies stdin/stdout to the browser via WebSocket. Authentication is via a short-lived token passed as a query parameter.

#### `handlers/settings.go`
Read settings (any authenticated user). Update settings (admin only). Settings are key-value rows in the `settings` table.

#### `handlers/alerts.go`, `handlers/audit.go`, `handlers/customers.go`, `handlers/inventory.go`
Standard list/resolve handlers for their respective tables.

### Package: `internal/alerting`

`poller.go` — runs on a 60-second ticker.

**On each tick:**
1. `ListDevices()` — fetch all device records
2. `go pingDevices()` — for each device, in parallel goroutines:
   - Skip if `last_seen` is less than 60s ago (recently seen via PnP or syslog — no need to ping)
   - Determine IP to ping: `management_ip` → `last_connection_ip` → DHCP reservation IP
   - If no IP available, skip
   - Run `ping -c 1 -W 2 {ip}` via `exec.Command`
   - If ping succeeds, `UPDATE devices SET last_seen = NOW()`
3. `evaluate()` — check alert conditions for each device:
   - **Failed**: status == 'failed' → upsert critical alert
   - **Firmware drift**: device firmware != profile target firmware → upsert warning alert
   - **Offline**: status == 'provisioned' AND last_seen > 4 hours ago → upsert warning alert

The ping priority order matters: `management_ip` is manually set and authoritative. `last_connection_ip` is auto-detected from the most recent ZTP config fetch. DHCP reservation is the fallback for anything else.

The 60-second interval means `last_seen` can be up to ~60 seconds stale for ping-only devices. For PnP devices (Cisco), it's as fresh as the PnP poll interval (~5s). For syslog-sending devices, it's as fresh as their syslog rate.

### Package: `internal/gitops`

`git.go` — shells out to the `git` binary (installed in the Alpine container). All functions are designed to be called in goroutines — they log errors but never return them.

**Two repos are involved:**
- **Backup repo** (`git.backup_repo_url`) — stores device running configs: `devices/{hostname-or-serial}/config.cfg`
- **Template repo** (`git.template_repo_url`) — stores templates and profiles: `templates/{vendor}/{os_type}/{name}.cfg` and `profiles/{customer}/{name}.json`

**Functions:**

`CommitConfig(ctx, pool, device, configText)`:
- Checks `git.backup_enabled == "true"` — exits silently if not
- Checks `git.backup_repo_url` — exits if empty
- Reads branch, token, author name/email from settings
- Injects token into URL via `injectToken()` (adds `oauth2:{token}@` to HTTPS URL)
- `git clone --depth=1 --single-branch --branch {branch} {url} .` into a temp dir
- If clone fails (empty/new repo): `git init` + `git remote add origin` + `git checkout -b {branch}`
- Writes `devices/{ident}/config.cfg`
- `git add -A`, `git commit -m "backup: ..."`, `git push`
- If commit fails with "nothing to commit", silently returns (config unchanged)

`CommitTemplate(ctx, pool, tmpl)`:
- Uses **template repo** settings (not backup repo)
- Only commits inline-content templates (`tmpl.Content != nil`). File-backed templates live on the renderer's disk and are not committed
- Writes to `templates/{vendor}/{os_type}/{name}.cfg`

`CommitProfile(ctx, pool, profile)`:
- Uses **template repo** settings
- Queries `customers` table to get customer name for directory organisation
- Writes to `profiles/{customer-name}/{profile-name}.json` as JSON

`SyncTemplates(ctx, pool)`:
- Uses template repo settings
- Clones without `--depth=1` (needs full history for empty-repo detection)
- Checks `git rev-parse HEAD` — returns error if repo has no commits
- Walks directory tree looking for `.cfg` and `.j2` files
- Path structure determines vendor/os_type/name:
  - `vendor/os_type/name.cfg` → vendor, os_type, name
  - `vendor/name.cfg` → vendor, "generic", name
- Calls `db.UpsertTemplate()` for each file
- Returns count of upserted templates

`injectToken(repoURL, token)`:
- Parses URL with `url.Parse()`
- Sets userinfo to `oauth2:{token}` — works with GitHub, Gitea, Forgejo, GitLab
- Returns modified URL string

### Package: `internal/discovery`

`poller.go` — polls Kea's lease table every 30 seconds. For each active lease, if no device record exists with that MAC, auto-creates one with status `discovered`. This catches devices that boot and get a DHCP lease but never reach the HTTP ZTP endpoint (e.g., HP ProCurve that only does TFTP).

---

## React UI (`services/dashboard/ui/`)

Built with Vite + React + TypeScript + Tailwind CSS + shadcn/ui components.

### Key Files

`src/lib/api.ts` — all TypeScript types mirroring Go models, plus the `api` object with `get()`, `post()`, `put()`, `delete()` methods. All authenticated calls include `Authorization: Bearer {token}` header. Token is stored in `localStorage`.

`src/lib/utils.ts` — `formatDate()`, `formatRelative()`, `cn()` (Tailwind class merger).

### Pages

#### `DevicesPage.tsx`
The most complex page. Shows a table of all devices with status badges and `last_seen`. Clicking a device opens `DeviceModal`.

**DeviceModal** is a centered dialog with five tabs:
- **Overview**: hostname, description, profile assignment, management IP, firmware version, status
- **Variables**: device-level variable overrides as key-value pairs. The **Discover Variables** button calls `GET /api/v1/templates/{id}/variables` for the assigned profile's template, then adds any variables not already present (pre-filled from profile values where available)
- **VLANs**: shows profile VLANs greyed-out; operator can check "Override" on any row to edit in-place. New rows can be added. On save, only overridden/new rows are written to `device.variables.vlans`
- **Ports**: same override pattern. Port schema: `{port, native_vlan, allowed_vlans?, description}`. The renderer decides access vs trunk — if `allowed_vlans` is present, it's a trunk; if absent, it's an access port
- **Config**: rendered config preview with diff view against previous

Variable merge at render time (in `handlers/devices.go`): profile variables are the base; device variables are merged on top (device wins on conflict).

#### `TemplatesPage.tsx`
CRUD for config templates. Supports both file-backed (select from renderer's file list) and inline (write Jinja2 directly in the editor). The **Sync from Git** button calls `POST /api/v1/git/sync-templates`.

#### `ProfilesPage.tsx`
CRUD for device profiles. VLANs and Ports tabs use the same schema as device overrides: `{id, name, description}` for VLANs, `{port, native_vlan, allowed_vlans?, description}` for ports. These become the baseline that device-level entries are layered on top of.

#### `EventsPage.tsx`
Syslog event viewer. Polls every 15 seconds. Device dropdown filters by `device_id` query param. The dropdown is populated from `GET /api/v1/devices` (shows all devices by name). Filter options:
- "All devices" — no filter
- Any device by name — filters via `?device_id={uuid}`
- "Unknown" — filters via `?device_id=unknown` → returns events with `device_id IS NULL`

The backend filter (`ListEvents` in `db.go`) matches a selected device against events via:
1. `syslog_events.device_id = $device_id` (new events, populated at insert)
2. `source_ip = devices.management_ip` (manually set IP)
3. `source_ip IN (dhcp_reservations WHERE device_id = $device_id)` (DHCP lease IP)
4. `lower(hostname) IN (device.hostname, device.serial)` (syslog hostname field — handles Juniper sending serial as hostname, NAT scenarios)

#### `SettingsPage.tsx`
Grouped settings editor. Categories: ZTP, SNMP, DHCP, Git Integration. Git settings control both the backup repo (for device configs) and the template repo (for templates/profiles).

---

## ZTP Flow — Step by Step

### Cisco Catalyst (PnP)

1. Device boots, gets IP from Kea via DHCP
2. Kea classifies as `ciscoSystems` (option 60), sends PnP server address in option 43
3. Device sends `POST /pnp/HELLO` to ZTP server
4. `pnpH.Hello()` looks up device by serial in UDI string, auto-registers if new
5. Device sends `POST /pnp/WORK-REQUEST`
6. `pnpH.WorkRequest()` checks if device has a profile:
   - No profile → returns BYE XML, updates `last_seen`
   - Profile assigned → renders config via renderer, returns config-apply job XML
7. Device applies config, sends `POST /pnp/WORK-RESPONSE` with success/failure
8. `pnpH.WorkResponse()` reads result, updates device status
9. Device continues polling WORK-REQUEST every ~5 seconds indefinitely

### Juniper EX/QFX

1. Device boots, gets IP from Kea
2. Juniper's ZTP mechanism does `GET /juniper/{serial}/config`
3. `juniperH.ZTPConfig()`:
   - Looks up by serial, auto-registers if not found
   - Sets `last_connection_ip` from source IP (used for ping)
   - If no profile: returns 404 (device will retry)
   - If profile: merges variables, calls renderer, returns config
4. Device applies config
5. Device logs "configuration applied" or similar via syslog → syslog receiver marks as `provisioned`

### Aruba/HP

1. Device boots, gets IP + TFTP/boot options from Kea
2. Older devices: TFTP download of boot file, then HTTP request to `GET /aruba/config?mac={mac}`
3. `arubaH.ZTPConfig()` — same lookup/render/return pattern as Juniper
4. Newer AOS-CX devices: similar HTTP flow

### Generic (TFTP only, e.g. HP ProCurve)

1. Device boots, gets IP and TFTP server/filename from Kea
2. TFTP download of config file from `services/tftp/tftpboot/`
3. No HTTP contact with ZTP server — `discovery.RunLeasePoller()` detects the lease and creates a device record with status `discovered`

---

## Variable Merging at Render Time

When `deviceH.ZTPConfig()` or `deviceH.GetConfig()` renders a config:

1. Get device record → `device.variables` (device-level overrides)
2. Get profile record → `profile.variables` (profile defaults)
3. Merge: start with profile variables, then overlay device variables (device wins)
4. Add system-injected variables: `hostname`, `serial`, `mac`
5. POST to renderer: `{template_name: "...", variables: {merged}}`
6. Return rendered text

The VLAN and port variables (`vlans`, `ports`) follow the same merge. At the device level, only rows with `overridden: true` or `fromProfile: false` are stored. At render time, the full merged set is reconstructed.

---

## Authentication

### Local Auth
- Passwords stored as bcrypt hashes in `users.password_hash`
- `POST /api/v1/auth/login` returns a JWT
- JWT is HS256, signed with `JWT_SECRET` env var
- Token stored in browser `localStorage` and sent as `Authorization: Bearer {token}` on every API request

### OIDC / Azure AD
- Enabled by setting `OIDC_ENABLED=true` and providing `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URL`
- Flow: browser → `/api/v1/auth/oidc/redirect` → Azure AD → `/api/v1/auth/oidc/callback` → ZTP issues its own JWT
- OIDC user is matched by `oidc_sub` (Azure AD object ID). First login creates a local user record
- Role is determined by the local user record, not from Azure AD claims

### Roles
Three roles: `admin`, `editor`, `viewer`. Admin can manage settings and users. The role is embedded in the JWT and enforced by `RequireRole()` middleware on sensitive routes.

---

## Git Integration

### Backup Repo (device configs)

Settings: `git.backup_enabled`, `git.backup_repo_url`, `git.backup_branch`, `git.backup_token`, `git.backup_author_name`, `git.backup_author_email`

Triggered automatically (in background goroutines, errors only logged):
- After `RunningConfig` pull from device
- After `PushConfig` to device

Repo structure:
```
devices/
  {hostname-or-serial}/
    config.cfg
```

### Template Repo (templates and profiles)

Settings: `git.template_repo_url`, `git.template_branch`, `git.template_token`

Triggered automatically:
- After template Create or Update (inline content only — file-backed templates are not committed)
- After profile Create or Update

Repo structure:
```
templates/
  {vendor}/
    {os_type}/
      {name}.cfg
profiles/
  {customer-name}/
    {profile-name}.json
```

The **Sync from Git** button (TemplatesPage) clones the template repo and walks `.cfg`/`.j2` files to upsert into the DB. This is the pull direction. The auto-commit on save is the push direction. Both use the same repo.

### Authentication

Token auth is injected into the HTTPS URL as `https://oauth2:{token}@host/path.git`. This works with GitHub PATs, Gitea/Forgejo tokens, and GitLab PATs. SSH is not supported.

### Empty Repo Handling

`CommitConfig`/`CommitTemplate`/`CommitProfile` will `git init` + `git remote add` + `git checkout -b {branch}` if clone fails (handles brand-new repos). `SyncTemplates` explicitly checks `git rev-parse HEAD` and returns an error if the repo is empty — there's nothing to sync from an empty repo.

---

## Liveness / Last Seen

Three mechanisms update `devices.last_seen`, in priority order (as documented in the alerting poller):

1. **Cisco PnP polling** — every ~5 seconds, every WORK-REQUEST updates `last_seen`. Most reliable but Cisco-specific.

2. **Syslog receipt** — `updateDeviceLastSeen()` runs on every syslog message. Reliability depends on device syslog rate. Works for Juniper, Aruba, and any device configured to send syslog to `{server-ip}:514`.

3. **Ping** (fallback) — runs every 60 seconds for devices not seen within the last 60 seconds. Uses first available IP from: `management_ip` → `last_connection_ip` → DHCP reservation. Shells out to `ping -c 1 -W 2`.

`last_connection_ip` is set by the Juniper handler when a device fetches its config. It is the source IP of the HTTP request, so it only works correctly when Juniper devices are not behind NAT (which they typically aren't — they're local devices reaching the ZTP server directly). `management_ip` is always manually set by operators and is authoritative when present.

---

## Adding a New Device Vendor

To support a new vendor's ZTP protocol:

1. **Jinja2 template** — add a `.cfg` file under `configs/{vendor}/{os_type}/`. Variable names should match what the profile/device variables will provide.

2. **API handler** (if new protocol) — create `services/dashboard/api/internal/handlers/{vendor}.go`. Follow the Juniper or Aruba handler as a model:
   - Identify the device (MAC or serial from request params/headers)
   - Call `db.GetDeviceByIdentifier()` or `db.GetDeviceByMAC()`
   - Auto-register if not found
   - Set `last_connection_ip` from source IP
   - If no profile: return appropriate error to trigger retry
   - Merge variables, call renderer, return rendered config

3. **Route** — register the route in `main.go` as unauthenticated

4. **Syslog keywords** — if the vendor logs a provisioning-complete message, add the keyword to `provisionedKeywords` in `syslog/main.go`

5. **Kea classification** — add a client class in `kea-dhcp4.json` to send the correct DHCP options (TFTP server, boot file, or PnP server) for this vendor's option 60 value

---

## Common Maintenance Tasks

### Adding a database column

1. Write the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` statement
2. Add a new init file (e.g., `10-new-column.sql`) for fresh deployments
3. Run the ALTER on the live database manually: `docker compose exec postgres psql -U ztp -d ztp -c "ALTER TABLE ..."`
4. Update the Go model struct in `models/models.go`
5. Update every SELECT in `db.go` that touches that table to include the new column
6. Update the `scanDevice()` (or equivalent scan function) to scan the new column
7. Rebuild and deploy the API

### Changing a setting key

Settings keys are seeded by `01-schema.sql` and `08-git-settings.sql`. To add a new setting:
1. Add the INSERT to the appropriate init SQL file (for fresh installs)
2. Run the INSERT on the live DB: `INSERT INTO settings (key, label, description, category) VALUES (...) ON CONFLICT (key) DO NOTHING`
3. In Go, read it with `dbpkg.GetSettingValue(ctx, pool, "new.key")`
4. In the UI, the Settings page will auto-discover it — just add the category to `CATEGORY_LABELS` if it's a new category

### Debugging git backup failures

All git operations log at DEBUG level on failure. Run: `docker compose logs api | grep "git backup"`. The most common causes:
- `git.backup_enabled` not set to `"true"`
- Invalid or expired token
- Repo URL typo (double `http://` from user input is handled gracefully by `injectToken()`)
- The `git` binary is in the container (Alpine: `apk add git`)
- Empty repo — backup functions handle this with init fallback

### Debugging syslog matching

If syslog events show as "Unknown" for devices that should be matched:
1. Check `SELECT hostname FROM syslog_events WHERE source_ip = 'x.x.x.x' LIMIT 5` — see what hostname field the device sends
2. Check `SELECT hostname, serial, management_ip FROM devices` — ensure the syslog hostname matches one of these
3. Juniper typically sends its serial as the syslog hostname — the `resolveDeviceID()` function checks both `hostname` and `serial` columns
4. If behind NAT, IP matching won't work — hostname matching is the only option

### Backfilling device_id on existing syslog events

After adding management_ip or fixing hostnames:
```sql
UPDATE syslog_events e
SET device_id = (
  SELECT d.id FROM devices d
  WHERE lower(d.hostname) = lower(e.hostname)
     OR lower(d.serial) = lower(e.hostname)
     OR d.management_ip = e.source_ip
  LIMIT 1
)
WHERE e.device_id IS NULL;
```

---

## Environment Variables Reference

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `POSTGRES_HOST` | Yes | localhost | DB hostname |
| `POSTGRES_PORT` | No | 5432 | DB port |
| `POSTGRES_DB` | Yes | ztp | DB name |
| `POSTGRES_USER` | Yes | ztp | DB user |
| `POSTGRES_PASSWORD` | Yes | changeme | DB password |
| `JWT_SECRET` | Yes | — | JWT signing key (min 32 chars recommended) |
| `JWT_EXPIRY` | No | 24h | Token lifetime (Go duration string) |
| `OIDC_ENABLED` | No | false | Enable Azure AD SSO |
| `OIDC_ISSUER` | If OIDC | — | e.g. `https://login.microsoftonline.com/{tenant}/v2.0` |
| `OIDC_CLIENT_ID` | If OIDC | — | Azure AD application ID |
| `OIDC_CLIENT_SECRET` | If OIDC | — | Azure AD client secret |
| `OIDC_REDIRECT_URL` | If OIDC | — | Must match Azure AD app registration |
| `RENDERER_URL` | No | http://localhost:8001 | Internal renderer URL |
| `KEA_CTRL_AGENT_URL` | No | http://localhost:8000 | Kea control agent URL |
| `API_PORT` | No | 8080 | API listen port |
| `SYSLOG_UDP_PORT` | No | 514 | Syslog UDP listen port |
| `SYSLOG_TCP_PORT` | No | 514 | Syslog TCP listen port |

---

## Technology Choices and Why

- **Go for API and syslog**: low memory, fast startup, single binary, excellent concurrency for handling many simultaneous device connections
- **pgx/v5**: fastest PostgreSQL driver for Go; connection pooling built in
- **chi router**: lightweight, idiomatic, middleware-first
- **zerolog**: structured JSON logging with zero allocations
- **Python/FastAPI for renderer**: Jinja2 is the de facto standard for network config templating; Python has the best Jinja2 support; FastAPI is fast enough for synchronous render calls
- **React + shadcn/ui**: shadcn gives accessible, unstyled components that are fully owned (not a dependency) — easy to customise
- **Shell-out to `git` binary**: avoids go-git (which has known protocol compatibility issues) and libgit2 CGO complexity; the `git` binary in Alpine is reliable and well-tested
- **PostgreSQL only**: no separate cache (Redis etc.) — the workload doesn't warrant it; pgx connection pooling is sufficient
