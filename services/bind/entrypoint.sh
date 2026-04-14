#!/bin/bash
set -euo pipefail

# Copy configs to a writable working directory and substitute env vars.
# The source volume (/etc/bind) is mounted read-only and must not be modified.
WORK_DIR="/tmp/bind"
mkdir -p "$WORK_DIR/zones"

for f in /etc/bind/*.conf; do
    [ -f "$f" ] && envsubst < "$f" > "$WORK_DIR/$(basename "$f")"
done

for f in /etc/bind/zones/*.zone; do
    [ -f "$f" ] && envsubst < "$f" > "$WORK_DIR/zones/$(basename "$f")"
done

echo "[bind] Starting named..."
exec named -f -u named -c "$WORK_DIR/named.conf"
