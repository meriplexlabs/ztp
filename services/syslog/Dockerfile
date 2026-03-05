FROM golang:1.23-alpine AS builder

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o ztp-syslog .

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM alpine:3.21

RUN adduser -D -u 1000 ztp
USER ztp

COPY --from=builder /build/ztp-syslog /ztp-syslog

EXPOSE 514/udp 514/tcp

ENTRYPOINT ["/ztp-syslog"]
