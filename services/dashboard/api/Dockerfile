# ─── Build stage ──────────────────────────────────────────────────────────────
FROM golang:1.23-alpine AS builder

WORKDIR /build

# Cache dependencies
COPY go.mod go.sum ./
RUN go mod download

# Build
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o ztp-api \
    ./cmd/api/main.go

# ─── Runtime stage (alpine, non-root) ────────────────────────────────────────
FROM alpine:3.21

RUN adduser -D -u 1000 ztp
USER ztp

COPY --from=builder /build/ztp-api /ztp-api

EXPOSE 8080

ENTRYPOINT ["/ztp-api"]
