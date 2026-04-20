package alerting

import (
	"context"
	"fmt"
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
			if err := evaluate(ctx, pool); err != nil {
				log.Error().Err(err).Msg("Alert evaluation failed")
			}
		}
	}
}

func evaluate(ctx context.Context, pool *pgxpool.Pool) error {
	devices, err := dbpkg.ListDevices(ctx, pool)
	if err != nil {
		return fmt.Errorf("list devices: %w", err)
	}
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
