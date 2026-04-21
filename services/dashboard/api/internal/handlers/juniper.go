package handlers

import (
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	dbpkg "github.com/ztp/api/internal/db"
	"github.com/ztp/api/internal/models"
)

// JuniperHandler serves ZTP config to Juniper devices.
//
// Juniper sends its serial as DHCP option 12 (hostname). The Kea flex-option hook
// uses that serial to set option 67 = "juniper/<serial>/config", so the device
// fetches a per-device URL. The serial is in the URL path — no source IP lookup —
// so NAT between the switch and the server is not a problem.
type JuniperHandler struct {
	pool        *pgxpool.Pool
	rendererURL string
}

func NewJuniperHandler(pool *pgxpool.Pool, rendererURL string) *JuniperHandler {
	return &JuniperHandler{pool: pool, rendererURL: rendererURL}
}

// ZTPConfig handles GET /juniper/{serial}/config — unauthenticated, called by the device.
func (h *JuniperHandler) ZTPConfig(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	serial := strings.ToLower(chi.URLParam(r, "serial"))

	log.Info().Str("serial", serial).Msg("Juniper ZTP config request")

	// Look up the active lease for this serial to get the MAC address
	var hwaddrHex string
	row := h.pool.QueryRow(ctx, `
		SELECT encode(hwaddr, 'hex') AS hwaddr_hex
		FROM lease4
		WHERE hostname = $1 AND state = 0
		LIMIT 1
	`, serial)
	// MAC lookup is best-effort — device registration works without it
	_ = row.Scan(&hwaddrHex)
	mac := formatMAC(hwaddrHex)

	// Auto-register or look up device by serial
	device, err := dbpkg.GetDeviceByIdentifier(ctx, h.pool, serial)
	if err != nil {
		vendor := "juniper"
		newDevice := &models.Device{
			Serial:      &serial,
			VendorClass: &vendor,
			Status:      models.StatusDiscovered,
			Variables:   map[string]any{},
		}
		if mac != "" {
			newDevice.MAC = &mac
		}
		if createErr := dbpkg.CreateDevice(ctx, h.pool, newDevice); createErr != nil {
			// Race: another request may have created it simultaneously
			device, err = dbpkg.GetDeviceByIdentifier(ctx, h.pool, serial)
			if err != nil {
				log.Error().Err(createErr).Str("serial", serial).Msg("Juniper ZTP: failed to register device")
				http.Error(w, "failed to register device", http.StatusInternalServerError)
				return
			}
			log.Info().Str("serial", serial).Msg("Juniper ZTP: device already existed, re-fetched")
		} else {
			device = newDevice
			log.Info().Str("serial", serial).Str("mac", mac).Msg("Juniper ZTP: auto-registered device")
		}
	}

	// Update last_seen, management_ip, and backfill MAC if needed
	remoteIP, _, _ := net.SplitHostPort(r.RemoteAddr)
	now := time.Now()
	if device.MAC == nil && mac != "" {
		device.MAC = &mac
		_, _ = h.pool.Exec(ctx,
			`UPDATE devices SET last_seen = $1, mac = $2, management_ip = COALESCE(management_ip, $3::inet) WHERE id = $4`,
			now, mac, remoteIP, device.ID)
	} else {
		_, _ = h.pool.Exec(ctx,
			`UPDATE devices SET last_seen = $1, management_ip = COALESCE(management_ip, $2::inet) WHERE id = $3`,
			now, remoteIP, device.ID)
	}

	// No profile → discovered but not provisioned yet; signal retry
	if device.ProfileID == nil {
		log.Info().Str("serial", serial).Msg("Juniper ZTP: no profile assigned, sending 404 to trigger retry")
		http.Error(w, "no profile assigned — device registered, assign a profile in the dashboard", http.StatusNotFound)
		return
	}

	// Mark provisioning and render config
	device.Status = models.StatusProvisioning
	_ = dbpkg.UpdateDevice(ctx, h.pool, device)

	dh := &DeviceHandler{pool: h.pool, rendererURL: h.rendererURL}
	config, err := dh.renderConfig(r, device)
	if err != nil {
		device.Status = models.StatusFailed
		_ = dbpkg.UpdateDevice(ctx, h.pool, device)
		log.Error().Err(err).Str("serial", serial).Msg("Juniper ZTP: render failed")
		http.Error(w, "render failed: "+err.Error(), http.StatusBadGateway)
		return
	}

	// Mark provisioned
	device.Status = models.StatusProvisioned
	provTime := time.Now()
	device.ProvisionedAt = &provTime
	_ = dbpkg.UpdateDevice(ctx, h.pool, device)

	log.Info().Str("serial", serial).Msg("Juniper ZTP: serving config")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprint(w, config)
}

// formatMAC converts a raw hex string to colon-separated notation.
// e.g. "c878f729614a" → "c8:78:f7:29:61:4a"
func formatMAC(hex string) string {
	if len(hex) != 12 {
		return ""
	}
	return fmt.Sprintf("%s:%s:%s:%s:%s:%s",
		hex[0:2], hex[2:4], hex[4:6], hex[6:8], hex[8:10], hex[10:12])
}
