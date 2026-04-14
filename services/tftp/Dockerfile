FROM python:3.12-slim

RUN pip install --no-cache-dir tftpy

RUN mkdir -p /tftpboot

EXPOSE 69/udp

# tftpy operates in single-port mode — all traffic stays on UDP 69,
# no ephemeral ports, works through stateful firewalls without ALG.
CMD ["python", "-c", "\
import tftpy, os, logging; \
logging.basicConfig(level=logging.INFO); \
tftpy.TftpServer(os.environ.get('TFTP_ROOT', '/tftpboot')).listen('0.0.0.0', 69)"]
