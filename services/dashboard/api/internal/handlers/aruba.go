package handlers

import (
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	dbpkg "github.com/ztp/api/internal/db"
	"github.com/ztp/api/internal/models"
)

// ArubaHandler serves ZTP config to Aruba AOS-CX devices.
// The switch MAC is embedded in the URL by Kea's flex-option hook, so device
// identity comes from the path — source IP is not used (NAT-safe).
type ArubaHandler struct {
	pool        *pgxpool.Pool
	rendererURL string
}

func NewArubaHandler(pool *pgxpool.Pool, rendererURL string) *ArubaHandler {
	return &ArubaHandler{pool: pool, rendererURL: rendererURL}
}

// ZTPConfig handles GET /aruba/{mac}/config — unauthenticated, called by the device.
func (h *ArubaHandler) ZTPConfig(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	mac := chi.URLParam(r, "mac")

	log.Info().Str("mac", mac).Msg("Aruba ZTP config request")

	// Auto-register or look up device by MAC
	device, err := dbpkg.GetDeviceByIdentifier(ctx, h.pool, mac)
	if err != nil {
		vendor := "aruba"
		newDevice := &models.Device{
			MAC:         &mac,
			VendorClass: &vendor,
			Status:      models.StatusDiscovered,
			Variables:   map[string]any{},
		}
		if createErr := dbpkg.CreateDevice(ctx, h.pool, newDevice); createErr != nil {
			// Race: another request may have created it simultaneously
			device, err = dbpkg.GetDeviceByIdentifier(ctx, h.pool, mac)
			if err != nil {
				log.Error().Err(createErr).Str("mac", mac).Msg("Aruba ZTP: failed to register device")
				http.Error(w, "failed to register device", http.StatusInternalServerError)
				return
			}
			log.Info().Str("mac", mac).Msg("Aruba ZTP: device already existed, re-fetched")
		} else {
			device = newDevice
			log.Info().Str("mac", mac).Msg("Aruba ZTP: auto-registered device")
		}
	}

	now := time.Now()
	_, _ = h.pool.Exec(ctx,
		`UPDATE devices SET last_seen = $1 WHERE id = $2`,
		now, device.ID)

	if device.ProfileID == nil {
		log.Info().Str("mac", mac).Msg("Aruba ZTP: no profile assigned, sending 404 to trigger retry")
		http.Error(w, "no profile assigned — device registered, assign a profile in the dashboard", http.StatusNotFound)
		return
	}

	device.Status = models.StatusProvisioning
	_ = dbpkg.UpdateDevice(ctx, h.pool, device)

	dh := &DeviceHandler{pool: h.pool, rendererURL: h.rendererURL}
	config, err := dh.renderConfig(r, device)
	if err != nil {
		device.Status = models.StatusFailed
		_ = dbpkg.UpdateDevice(ctx, h.pool, device)
		log.Error().Err(err).Str("mac", mac).Msg("Aruba ZTP: render failed")
		http.Error(w, "render failed: "+err.Error(), http.StatusBadGateway)
		return
	}

	device.Status = models.StatusProvisioned
	provTime := time.Now()
	device.ProvisionedAt = &provTime
	_ = dbpkg.UpdateDevice(ctx, h.pool, device)

	log.Info().Str("mac", mac).Msg("Aruba ZTP: serving config")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprint(w, config)
}
