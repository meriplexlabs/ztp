#!/bin/bash
set -euo pipefail

# Substitute env vars into config files
for f in /etc/bind/*.conf /etc/bind/zones/*.zone; do
    [ -f "$f" ] && envsubst < "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done

echo "[bind] Starting named..."
exec named -f -u named -c /etc/bind/named.conf
