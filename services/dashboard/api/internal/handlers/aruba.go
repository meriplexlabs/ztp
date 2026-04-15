package handlers

import (
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	dbpkg "github.com/ztp/api/internal/db"
	"github.com/ztp/api/internal/models"
)

// ArubaHandler serves ZTP config to HP ProCurve / Aruba AOS devices.
// The switch is identified by MAC address looked up from the DHCP lease4 table.
// Requires firmware K.15.18+ for HTTP-based autoinstall (option 67 with http:// URL).
type ArubaHandler struct {
	pool        *pgxpool.Pool
	rendererURL string
}

func NewArubaHandler(pool *pgxpool.Pool, rendererURL string) *ArubaHandler {
	return &ArubaHandler{pool: pool, rendererURL: rendererURL}
}

// ZTPConfig handles GET /aruba/config — unauthenticated, called by the device.
func (h *ArubaHandler) ZTPConfig(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Resolve client IP (handle nginx X-Real-IP proxy header)
	clientIP := r.Header.Get("X-Real-IP")
	if clientIP == "" {
		clientIP, _, _ = net.SplitHostPort(r.RemoteAddr)
	}

	log.Info().Str("client_ip", clientIP).Msg("Aruba ZTP config request")

	// Look up DHCP lease for this IP — extract MAC address
	var hwaddrHex string
	row := h.pool.QueryRow(ctx, `
		SELECT encode(hwaddr, 'hex') AS hwaddr_hex
		FROM lease4
		WHERE
			((address >> 24) & 255)::text || '.' ||
			((address >> 16) & 255)::text || '.' ||
			((address >> 8)  & 255)::text || '.' ||
			(address         & 255)::text = $1
			AND state = 0
		LIMIT 1
	`, clientIP)
	if err := row.Scan(&hwaddrHex); err != nil {
		log.Warn().Str("ip", clientIP).Msg("Aruba ZTP: no active DHCP lease for IP")
		http.Error(w, "no active lease for this IP", http.StatusNotFound)
		return
	}

	mac := formatMAC(hwaddrHex)
	if mac == "" {
		log.Warn().Str("ip", clientIP).Str("hwaddr_hex", hwaddrHex).Msg("Aruba ZTP: could not parse MAC from lease")
		http.Error(w, "could not determine device MAC", http.StatusInternalServerError)
		return
	}

	log.Info().Str("ip", clientIP).Str("mac", mac).Msg("Aruba ZTP: identified device")

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

	// Update last_seen
	now := time.Now()
	_, _ = h.pool.Exec(ctx,
		`UPDATE devices SET last_seen = $1 WHERE id = $2`,
		now, device.ID)

	// No profile → discovered but not provisioned yet; signal retry
	if device.ProfileID == nil {
		log.Info().Str("mac", mac).Msg("Aruba ZTP: no profile assigned, sending 404 to trigger retry")
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
		log.Error().Err(err).Str("mac", mac).Msg("Aruba ZTP: render failed")
		http.Error(w, "render failed: "+err.Error(), http.StatusBadGateway)
		return
	}

	// Mark provisioned
	device.Status = models.StatusProvisioned
	provTime := time.Now()
	device.ProvisionedAt = &provTime
	_ = dbpkg.UpdateDevice(ctx, h.pool, device)

	log.Info().Str("mac", mac).Msg("Aruba ZTP: serving config")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprint(w, config)
}
