CREATE TABLE IF NOT EXISTS alerts (
    id          BIGSERIAL    PRIMARY KEY,
    type        VARCHAR(64)  NOT NULL,
    severity    VARCHAR(16)  NOT NULL DEFAULT 'warning',
    device_id   UUID         REFERENCES devices(id) ON DELETE CASCADE,
    message     TEXT         NOT NULL,
    resolved    BOOL         NOT NULL DEFAULT FALSE,
    resolved_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (type, device_id)
);

CREATE INDEX IF NOT EXISTS idx_alerts_resolved   ON alerts(resolved);
CREATE INDEX IF NOT EXISTS idx_alerts_device_id  ON alerts(device_id);
CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at DESC);
