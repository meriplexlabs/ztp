package alerting

import (
	"context"
	"fmt"
	"os/exec"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	dbpkg "github.com/ztp/api/internal/db"
	"github.com/ztp/api/internal/models"
)

// Run starts the alert poller. Call in a goroutine.
func Run(ctx context.Context, pool *pgxpool.Pool, interval time.Duration) {
	log.Info().Dur("interval", interval).Msg("Alert poller started")
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			devices, err := dbpkg.ListDevices(ctx, pool)
			if err != nil {
				log.Error().Err(err).Msg("Alert evaluation failed")
				continue
			}
			go pingDevices(ctx, pool, devices, interval)
			if err := evaluate(ctx, pool, devices); err != nil {
				log.Error().Err(err).Msg("Alert evaluation failed")
			}
		}
	}
}

func evaluate(ctx context.Context, pool *pgxpool.Pool, devices []models.Device) error {
	profiles, _ := dbpkg.ListProfiles(ctx, pool)

	// Build profile map keyed by ID
	type pfw struct{ name, version string }
	profileFW := make(map[string]pfw, len(profiles))
	for _, p := range profiles {
		if p.FirmwareVersion != nil {
			profileFW[p.ID.String()] = pfw{p.Name, *p.FirmwareVersion}
		}
	}

	for _, d := range devices {
		id := d.ID

		// ── Failed ──────────────────────────────────────────────────────────────
		if d.Status == models.StatusFailed {
			_ = dbpkg.UpsertAlert(ctx, pool, "failed", "critical", &id,
				fmt.Sprintf("Device %s is in failed state", name(d)))
		} else {
			_ = dbpkg.ResolveAlertByTypeAndDevice(ctx, pool, "failed", &id)
		}

		// ── Firmware drift ───────────────────────────────────────────────────────
		if d.ProfileID != nil && d.FirmwareVersion != nil {
			if p, ok := profileFW[d.ProfileID.String()]; ok {
				if p.version != *d.FirmwareVersion {
					_ = dbpkg.UpsertAlert(ctx, pool, "firmware_drift", "warning", &id,
						fmt.Sprintf("Device %s running %s, target is %s",
							name(d), *d.FirmwareVersion, p.version))
				} else {
					_ = dbpkg.ResolveAlertByTypeAndDevice(ctx, pool, "firmware_drift", &id)
				}
			}
		} else {
			_ = dbpkg.ResolveAlertByTypeAndDevice(ctx, pool, "firmware_drift", &id)
		}

		// ── Offline: provisioned but not seen in 4h ──────────────────────────────
		if d.Status == models.StatusProvisioned && d.LastSeen != nil {
			if time.Since(*d.LastSeen) > 4*time.Hour {
				_ = dbpkg.UpsertAlert(ctx, pool, "offline", "warning", &id,
					fmt.Sprintf("Device %s not seen for %s",
						name(d), time.Since(*d.LastSeen).Round(time.Minute)))
			} else {
				_ = dbpkg.ResolveAlertByTypeAndDevice(ctx, pool, "offline", &id)
			}
		}
	}
	return nil
}

func pingHost(ip string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := exec.CommandContext(ctx, "ping", "-c", "1", "-W", "2", ip).Run()
	return err == nil
}

func pingDevices(ctx context.Context, pool *pgxpool.Pool, devices []models.Device, interval time.Duration) {
	for _, d := range devices {
		// Skip if already seen recently via PnP or syslog
		if d.LastSeen != nil && time.Since(*d.LastSeen) < interval {
			continue
		}

		ip := ""
		switch {
		case d.ManagementIP != nil && *d.ManagementIP != "":
			ip = *d.ManagementIP
		case d.LastConnectionIP != nil && *d.LastConnectionIP != "":
			ip = *d.LastConnectionIP
		default:
			pool.QueryRow(ctx,
				`SELECT ip_address::text FROM dhcp_reservations WHERE device_id = $1 LIMIT 1`,
				d.ID,
			).Scan(&ip)
		}
		if ip == "" {
			continue
		}

		go func(deviceID string, ip string) {
			if pingHost(ip) {
				pool.Exec(ctx,
					`UPDATE devices SET last_seen = NOW() WHERE id = $1`, deviceID)
			}
		}(d.ID.String(), ip)
	}
}

func name(d models.Device) string {
	if d.Hostname != nil && *d.Hostname != "" {
		return *d.Hostname
	}
	if d.Serial != nil && *d.Serial != "" {
		return *d.Serial
	}
	if d.MAC != nil {
		return *d.MAC
	}
	return d.ID.String()[:8]
}
