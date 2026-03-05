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

# Start the Kea Control Agent in the background
echo "[entrypoint] Starting Kea Control Agent..."
kea-ctrl-agent -c "$WORK_DIR/kea-ctrl-agent.json" &
CTRL_PID=$!

# Give the control agent a moment to initialize
sleep 2

# Start Kea DHCP4 in the foreground
echo "[entrypoint] Starting Kea DHCP4..."
exec kea-dhcp4 -c "$WORK_DIR/kea-dhcp4.json"
