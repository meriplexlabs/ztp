FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        tftpd-hpa \
    && rm -rf /var/lib/apt/lists/*

# tftpd-hpa drops privileges to tftp user, ensure it exists
RUN id tftp 2>/dev/null || useradd --system --no-create-home --shell /bin/false tftp

# The tftp root — bind-mount your tftpboot dir here
RUN mkdir -p /tftpboot && chown -R tftp:tftp /tftpboot

# tftpd-hpa must be run as root to bind UDP/69, then drops to tftp user
# We grant only NET_BIND_SERVICE via compose rather than running fully as root
EXPOSE 69/udp

# tftpd-hpa daemonizes (forks) even with --listen, so PID 1 exits with 0 and
# Docker restarts the container endlessly. Start it then exec tail to keep the
# container alive. If tftpd fails to start (non-zero exit) tail won't run.
CMD ["sh", "-c", "in.tftpd --listen --user tftp --address 0.0.0.0:69 --secure /tftpboot --blocksize 1468 --verbose && exec tail -f /dev/null"]
