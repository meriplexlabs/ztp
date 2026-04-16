// Package discovery provides a background poller that auto-registers devices
// from Kea lease4 entries that don't yet have a device record.
// This covers TFTP-only vendors (e.g. HP ProCurve 2920) that never call the HTTP API.
package discovery

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	dbpkg "github.com/ztp/api/internal/db"
	"github.com/ztp/api/internal/models"
)

// RunLeasePoller polls lease4 every interval and creates a "discovered" device
// record for any active lease whose MAC is not already in the devices table.
func RunLeasePoller(ctx context.Context, pool *pgxpool.Pool, interval time.Duration) {
	log.Info().Dur("interval", interval).Msg("lease poller started")
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := syncLeases(ctx, pool); err != nil {
				log.Warn().Err(err).Msg("lease poller: sync error")
			}
		}
	}
}

type leaseRow struct {
	macHex   string
	hostname string // may be empty
}

func syncLeases(ctx context.Context, pool *pgxpool.Pool) error {
	rows, err := pool.Query(ctx, `
		SELECT encode(hwaddr, 'hex') AS mac_hex, COALESCE(hostname, '') AS hostname
		FROM lease4
		WHERE state = 0
		  AND NOT EXISTS (
		    SELECT 1 FROM devices d
		    WHERE (d.mac IS NOT NULL AND REPLACE(d.mac::text, ':', '') = encode(lease4.hwaddr, 'hex'))
		       OR (d.hostname IS NOT NULL AND lease4.hostname != '' AND LOWER(d.hostname) = LOWER(lease4.hostname))
		       OR (d.serial   IS NOT NULL AND lease4.hostname != '' AND LOWER(d.serial)   = LOWER(lease4.hostname))
		  )
	`)
	if err != nil {
		return fmt.Errorf("query leases: %w", err)
	}
	defer rows.Close()

	var unseen []leaseRow
	for rows.Next() {
		var lr leaseRow
		if err := rows.Scan(&lr.macHex, &lr.hostname); err != nil {
			return err
		}
		unseen = append(unseen, lr)
	}

	for _, lr := range unseen {
		mac := formatMAC(lr.macHex)
		if mac == "" {
			continue
		}

		d := &models.Device{
			MAC:       &mac,
			Status:    models.StatusDiscovered,
			Variables: map[string]any{},
		}
		if lr.hostname != "" {
			d.Hostname = &lr.hostname
		}

		if err := dbpkg.CreateDevice(ctx, pool, d); err != nil {
			// May already exist due to a race with another handler — not an error.
			log.Debug().Str("mac", mac).Err(err).Msg("lease poller: device already exists, skipping")
			continue
		}
		log.Info().Str("mac", mac).Str("hostname", lr.hostname).Msg("lease poller: auto-registered device")
	}
	return nil
}

// formatMAC converts a raw 12-char hex string to colon-separated notation.
func formatMAC(hex string) string {
	if len(hex) != 12 {
		return ""
	}
	return fmt.Sprintf("%s:%s:%s:%s:%s:%s",
		hex[0:2], hex[2:4], hex[4:6], hex[6:8], hex[8:10], hex[10:12])
}
