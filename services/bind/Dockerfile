FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        bind9 \
        bind9utils \
        bind9-doc \
        dnsutils \
        gettext-base \
    && rm -rf /var/lib/apt/lists/*

# Ensure named user exists (bind9 package creates it)
RUN id named 2>/dev/null || useradd --system --no-create-home --shell /bin/false named

# Runtime directories
RUN mkdir -p /var/cache/bind /var/run/named /etc/bind \
    && chown -R named:named /var/cache/bind /var/run/named /etc/bind

COPY config/ /etc/bind/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown -R named:named /etc/bind

USER named

EXPOSE 53/udp 53/tcp

ENTRYPOINT ["/entrypoint.sh"]
