package handlers

import (
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	dbpkg "github.com/ztp/api/internal/db"
	"github.com/ztp/api/internal/models"
)

var (
	reUDI        = regexp.MustCompile(`udi="([^"]+)"`)
	reCorrelator = regexp.MustCompile(`correlator="([^"]+)"`)
)

// PnPHandler handles Cisco PnP (Plug and Play) protocol requests.
// Protocol flow:
//  1. Switch boots → DHCP option 43 points to this server
//  2. Switch GET/POST /pnp/HELLO → server acknowledges, auto-registers device
//  3. Switch POST /pnp/WORK-REQUEST → server returns config URL (config-upgrade) or bye
//  4. Switch fetches config from URL, applies it
//  5. Switch POST /pnp/WORK-RESPONSE → server acknowledges with bye
type PnPHandler struct {
	pool        *pgxpool.Pool
	rendererURL string
}

func NewPnPHandler(pool *pgxpool.Pool, rendererURL string) *PnPHandler {
	return &PnPHandler{pool: pool, rendererURL: rendererURL}
}

// Hello handles GET/POST (initial discovery) and PUT (work result) to /pnp/HELLO.
func (h *PnPHandler) Hello(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	bodyStr := string(body)

	serial, model := parseUDI(bodyStr)
	if serial == "" {
		serial, model = parseUDI(r.URL.RawQuery)
	}
	if serial == "" {
		serial, model = parseUDI(r.Header.Get("X-Cisco-PnP-Device-UDI"))
	}
	udi := parseRawUDI(bodyStr)
	correlator := parseCorrelator(bodyStr)

	log.Info().
		Str("method", r.Method).
		Str("serial", serial).
		Str("model", model).
		Str("correlator", correlator).
		Str("remote", r.RemoteAddr).
		Msg("PnP HELLO")

	if serial == "" {
		w.Header().Set("Content-Type", "text/xml; charset=utf-8")
		fmt.Fprint(w, pnpByeResponse(udi, correlator))
		return
	}

	// PUT = work result from device after config was applied
	if r.Method == http.MethodPut {
		h.handleWorkResult(w, r, bodyStr, serial, udi, correlator)
		return
	}

	// GET/POST HELLO — register device, return bye (config delivery happens in WORK-REQUEST)
	h.handleHelloRegister(w, r, serial, model, udi, correlator)
}

func (h *PnPHandler) handleHelloRegister(w http.ResponseWriter, r *http.Request, serial, model, udi, correlator string) {
	ctx := r.Context()

	device, err := dbpkg.GetDeviceByIdentifier(ctx, h.pool, serial)
	if err != nil {
		vendor := "cisco"
		newDevice := &models.Device{
			Serial:      &serial,
			VendorClass: &vendor,
			Status:      models.StatusDiscovered,
			Variables:   map[string]any{},
		}
		if model != "" {
			desc := model
			newDevice.Description = &desc
		}
		if createErr := dbpkg.CreateDevice(ctx, h.pool, newDevice); createErr != nil {
			device, err = dbpkg.GetDeviceByIdentifier(ctx, h.pool, serial)
			if err != nil {
				log.Error().Err(createErr).Str("serial", serial).Msg("PnP: failed to register device")
				w.Header().Set("Content-Type", "text/xml; charset=utf-8")
				fmt.Fprint(w, pnpByeResponse(udi, correlator))
				return
			}
			log.Info().Str("serial", serial).Msg("PnP: device already exists, re-fetched")
		} else {
			device = newDevice
			log.Info().Str("serial", serial).Str("model", model).Msg("PnP: auto-registered new device")
		}
	}

	now := time.Now()
	_, _ = h.pool.Exec(ctx, `UPDATE devices SET last_seen = $1 WHERE id = $2`, now, device.ID)

	w.Header().Set("Content-Type", "text/xml; charset=utf-8")
	fmt.Fprint(w, pnpByeResponse(udi, correlator))
}

// WorkRequest handles POST /pnp/WORK-REQUEST — device requests work.
// Server responds with a config-upgrade URL if profile is assigned, or bye.
func (h *PnPHandler) WorkRequest(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	bodyStr := string(body)

	log.Info().
		Str("remote", r.RemoteAddr).
		Str("body", bodyStr).
		Msg("PnP WORK-REQUEST raw")

	serial, model := parseUDI(bodyStr)
	udi := parseRawUDI(bodyStr)
	correlator := parseCorrelator(bodyStr)

	if serial == "" {
		log.Warn().Msg("PnP WORK-REQUEST: no serial found")
		w.Header().Set("Content-Type", "text/xml; charset=utf-8")
		fmt.Fprint(w, pnpByeResponse(udi, correlator))
		return
	}

	h.handleWorkRequestForDevice(w, r, serial, model, udi, correlator)
}

func (h *PnPHandler) handleWorkRequestForDevice(w http.ResponseWriter, r *http.Request, serial, model, udi, correlator string) {
	ctx := r.Context()

	device, err := dbpkg.GetDeviceByIdentifier(ctx, h.pool, serial)
	if err != nil {
		// Auto-register if not seen yet
		vendor := "cisco"
		newDevice := &models.Device{
			Serial:      &serial,
			VendorClass: &vendor,
			Status:      models.StatusDiscovered,
			Variables:   map[string]any{},
		}
		if model != "" {
			desc := model
			newDevice.Description = &desc
		}
		if createErr := dbpkg.CreateDevice(ctx, h.pool, newDevice); createErr != nil {
			device, err = dbpkg.GetDeviceByIdentifier(ctx, h.pool, serial)
			if err != nil {
				log.Error().Err(createErr).Str("serial", serial).Msg("PnP: failed to register device")
				w.Header().Set("Content-Type", "text/xml; charset=utf-8")
				fmt.Fprint(w, pnpByeResponse(udi, correlator))
				return
			}
		} else {
			device = newDevice
			log.Info().Str("serial", serial).Str("model", model).Msg("PnP: auto-registered new device")
		}
	}

	now := time.Now()
	_, _ = h.pool.Exec(ctx, `UPDATE devices SET last_seen = $1 WHERE id = $2`, now, device.ID)

	w.Header().Set("Content-Type", "text/xml; charset=utf-8")

	if device.ProfileID != nil {
		// Tell the switch to fetch config from our ZTP config endpoint
		scheme := "http"
		configURL := fmt.Sprintf("%s://%s/api/v1/config/%s", scheme, r.Host, serial)

		device.Status = models.StatusProvisioning
		_ = dbpkg.UpdateDevice(ctx, h.pool, device)

		log.Info().Str("serial", serial).Str("url", configURL).Msg("PnP: directing to config URL")
		fmt.Fprint(w, pnpConfigUpgradeResponse(udi, correlator, configURL))
		return
	}

	log.Info().Str("serial", serial).Msg("PnP: no profile assigned, sending bye")
	fmt.Fprint(w, pnpByeResponse(udi, correlator))
}

// WorkResponse handles POST /pnp/WORK-RESPONSE — device reports outcome.
func (h *PnPHandler) WorkResponse(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	bodyStr := string(body)

	log.Info().
		Str("remote", r.RemoteAddr).
		Str("body", bodyStr).
		Msg("PnP WORK-RESPONSE raw")

	serial, _ := parseUDI(bodyStr)
	udi := parseRawUDI(bodyStr)
	correlator := parseCorrelator(bodyStr)

	if serial != "" {
		h.handleWorkResult(w, r, bodyStr, serial, udi, correlator)
		return
	}

	w.Header().Set("Content-Type", "text/xml; charset=utf-8")
	fmt.Fprint(w, pnpByeResponse(udi, correlator))
}

func (h *PnPHandler) handleWorkResult(w http.ResponseWriter, r *http.Request, body, serial, udi, correlator string) {
	ctx := r.Context()
	// success="0" and <errorInfo> both indicate failure; <fault> is a protocol-level fault
	success := !strings.Contains(body, `success="0"`) &&
		!strings.Contains(body, "<errorInfo>") &&
		!strings.Contains(body, "<fault>")

	device, err := dbpkg.GetDeviceByIdentifier(ctx, h.pool, serial)
	if err == nil {
		if success {
			device.Status = models.StatusProvisioned
			now := time.Now()
			device.ProvisionedAt = &now
		} else {
			device.Status = models.StatusFailed
		}
		_ = dbpkg.UpdateDevice(ctx, h.pool, device)
		log.Info().
			Str("serial", serial).
			Bool("success", success).
			Msg("PnP: work result received")
	}

	w.Header().Set("Content-Type", "text/xml; charset=utf-8")
	fmt.Fprint(w, pnpByeResponse(udi, correlator))
}

// ── XML helpers ───────────────────────────────────────────────────────────────

func parseRawUDI(body string) string {
	m := reUDI.FindStringSubmatch(body)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

func parseUDI(body string) (serial, model string) {
	m := reUDI.FindStringSubmatch(body)
	if len(m) < 2 {
		return "", ""
	}
	for _, part := range strings.Split(m[1], ",") {
		kv := strings.SplitN(part, ":", 2)
		if len(kv) != 2 {
			continue
		}
		switch kv[0] {
		case "PID":
			model = kv[1]
		case "SN":
			serial = kv[1]
		}
	}
	return
}

func parseCorrelator(body string) string {
	m := reCorrelator.FindStringSubmatch(body)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

// pnpConfigUpgradeResponse tells the switch to fetch its config from the given URL.
func pnpConfigUpgradeResponse(udi, correlator, configURL string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<pnp xmlns="urn:cisco:pnp" version="1.0" udi="%s">
  <request correlator="%s" xmlns="urn:cisco:pnp:config-upgrade">
    <config details="all">
      <copy>
        <source>
          <location>%s</location>
        </source>
      </copy>
    </config>
    <noReload/>
  </request>
</pnp>`, udi, correlator, configURL)
}

// pnpByeResponse ends the PnP session (no more work / acknowledgment).
func pnpByeResponse(udi, correlator string) string {
	corAttr := ""
	if correlator != "" {
		corAttr = fmt.Sprintf(` correlator="%s"`, correlator)
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<pnp xmlns="urn:cisco:pnp" version="1.0" udi="%s">
  <info xmlns="urn:cisco:pnp:work-info"%s>
    <workInfo>
      <bye/>
    </workInfo>
  </info>
</pnp>`, udi, corAttr)
}
