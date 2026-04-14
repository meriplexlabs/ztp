FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

# Install Kea from ISC packages
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        gnupg \
        gettext-base \
    && curl -fsSL https://dl.cloudsmith.io/public/isc/kea-2-6/gpg.key \
        | gpg --dearmor -o /usr/share/keyrings/isc-kea.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/isc-kea.gpg] https://dl.cloudsmith.io/public/isc/kea-2-6/deb/ubuntu noble main" \
        > /etc/apt/sources.list.d/isc-kea.list \
    && apt-get update && apt-get install -y --no-install-recommends \
        isc-kea-dhcp4 \
        isc-kea-ctrl-agent \
        isc-kea-hooks \
        isc-kea-admin \
        libpq5 \
        postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Create non-root kea user (Kea packages typically create this, but ensure it exists)
RUN id kea 2>/dev/null || useradd --system --no-create-home --shell /bin/false kea

# Runtime directories
RUN mkdir -p /var/run/kea /var/log/kea \
    && chown -R kea:kea /var/run/kea /var/log/kea /etc/kea

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r//' /entrypoint.sh && chmod +x /entrypoint.sh

# Kea needs root to open raw/AF_PACKET sockets for DHCP broadcast handling.
# Capabilities alone (NET_BIND_SERVICE, NET_ADMIN, NET_RAW) are insufficient
# for non-root processes without ambient capability inheritance.

EXPOSE 8000/tcp

ENTRYPOINT ["/entrypoint.sh"]
