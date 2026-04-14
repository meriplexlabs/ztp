#!/bin/bash
# Kea DHCP + Control Agent entrypoint
# Copies config templates to /tmp, substitutes env vars, then starts Kea.
# The source volume (/etc/kea) is never modified.

set -euo pipefail

CONFIG_DIR="/etc/kea"
WORK_DIR="/tmp/kea"

mkdir -p "$WORK_DIR"

# Clean up stale PID files from previous container runs
rm -f /var/run/kea/*.pid

# Substitute environment variables — write to working copy, never touch the source
for f in "$CONFIG_DIR"/*.json; do
    envsubst < "$f" > "$WORK_DIR/$(basename "$f")"
done

# Initialize Kea schema if not already present.
# kea-admin db-init refuses to run when ANY tables exist, which breaks shared
# databases. We check for Kea's own schema_version table and run the schema SQL
# directly via psql so it coexists with our app tables.
echo "[entrypoint] Checking Kea database schema..."
SCHEMA_EXISTS=$(PGPASSWORD="$POSTGRES_PASSWORD" psql \
    -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='schema_version'" \
    2>/dev/null || echo "0")

if [ "$SCHEMA_EXISTS" = "0" ]; then
    echo "[entrypoint] Kea schema not found — initializing..."
    PGPASSWORD="$POSTGRES_PASSWORD" psql \
        -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" \
        -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -f /usr/share/kea/scripts/pgsql/dhcpdb_create.pgsql
    echo "[entrypoint] Kea schema initialized."
else
    echo "[entrypoint] Kea schema already present — skipping init."
fi

# Start the Kea Control Agent in the background
echo "[entrypoint] Starting Kea Control Agent..."
kea-ctrl-agent -c "$WORK_DIR/kea-ctrl-agent.json" &
CTRL_PID=$!

# Give the control agent a moment to initialize
sleep 2

# Start Kea DHCP4 in the foreground
echo "[entrypoint] Starting Kea DHCP4..."
exec kea-dhcp4 -c "$WORK_DIR/kea-dhcp4.json"
