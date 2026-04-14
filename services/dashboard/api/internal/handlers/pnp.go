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
// Flow: switch boots → DHCP option 43 points to this server →
//
//	switch POSTs /pnp/HELLO → we return config or no-op →
//	switch applies config → switch PUTs /pnp/HELLO with result.
type PnPHandler struct {
	pool        *pgxpool.Pool
	rendererURL string
}

func NewPnPHandler(pool *pgxpool.Pool, rendererURL string) *PnPHandler {
	return &PnPHandler{pool: pool, rendererURL: rendererURL}
}

// Hello handles both POST (initial discovery) and PUT (work result) to /pnp/HELLO.
func (h *PnPHandler) Hello(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	bodyStr := string(body)

	serial, model := parseUDI(bodyStr)
	correlator := parseCorrelator(bodyStr)

	log.Info().
		Str("method", r.Method).
		Str("serial", serial).
		Str("model", model).
		Str("correlator", correlator).
		Str("remote", r.RemoteAddr).
		Msg("PnP HELLO")

	if serial == "" {
		log.Warn().Str("body", bodyStr).Msg("PnP: no serial in UDI")
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	// PUT = work result from device after config was applied
	if r.Method == http.MethodPut {
		h.handleWorkResult(w, r, bodyStr, serial)
		return
	}

	// POST = discovery HELLO — upsert device, return config or no-op
	h.handleHello(w, r, serial, model, correlator)
}

func (h *PnPHandler) handleHello(w http.ResponseWriter, r *http.Request, serial, model, correlator string) {
	ctx := r.Context()

	device, err := dbpkg.GetDeviceByIdentifier(ctx, h.pool, serial)
	if err != nil {
		// Auto-register new device
		vendor := "cisco"
		device = &models.Device{
			Serial:      &serial,
			VendorClass: &vendor,
			Status:      models.StatusDiscovered,
			Variables:   map[string]any{},
		}
		if model != "" {
			desc := model
			device.Description = &desc
		}
		if createErr := dbpkg.CreateDevice(ctx, h.pool, device); createErr != nil {
			log.Error().Err(createErr).Str("serial", serial).Msg("PnP: failed to register device")
		} else {
			log.Info().Str("serial", serial).Str("model", model).Msg("PnP: auto-registered new device")
		}
	}

	// Update last seen
	now := time.Now()
	_, _ = h.pool.Exec(ctx,
		`UPDATE devices SET last_seen = $1 WHERE id = $2`, now, device.ID)

	w.Header().Set("Content-Type", "text/xml; charset=utf-8")

	// If device has a profile, render and return config
	if device.ProfileID != nil {
		dh := &DeviceHandler{pool: h.pool, rendererURL: h.rendererURL}
		config, renderErr := dh.renderConfig(r, device)
		if renderErr == nil {
			device.Status = models.StatusProvisioning
			_ = dbpkg.UpdateDevice(ctx, h.pool, device)
			log.Info().Str("serial", serial).Msg("PnP: sending config")
			fmt.Fprint(w, pnpConfigResponse(correlator, config))
			return
		}
		log.Warn().Err(renderErr).Str("serial", serial).Msg("PnP: render failed, sending no-op")
	}

	// No profile assigned yet — tell device to check back
	log.Info().Str("serial", serial).Msg("PnP: no profile assigned, sending no-op")
	fmt.Fprint(w, pnpNoOpResponse(correlator))
}

func (h *PnPHandler) handleWorkResult(w http.ResponseWriter, r *http.Request, body, serial string) {
	ctx := r.Context()
	success := strings.Contains(body, `success="true"`) || strings.Contains(body, "success=true")

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
	fmt.Fprint(w, pnpAckResponse())
}

// ── XML helpers ───────────────────────────────────────────────────────────────

func parseUDI(body string) (serial, model string) {
	m := reUDI.FindStringSubmatch(body)
	if len(m) < 2 {
		return "", ""
	}
	// UDI format: "PID:C9200L-48P-4G,VID:V01,SN:FOC1234ABCD"
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
		return "uid=0"
	}
	return m[1]
}

func pnpConfigResponse(correlator, config string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<pnp xmlns="urn:cisco:pnp" version="1.0">
  <response correlator="%s" success="true" xmlns="urn:cisco:pnp:work-info">
    <work-response>
      <work-info id="1">
        <config>
          <text><![CDATA[%s]]></text>
        </config>
      </work-info>
    </work-response>
  </response>
</pnp>`, correlator, config)
}

func pnpNoOpResponse(correlator string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<pnp xmlns="urn:cisco:pnp" version="1.0">
  <response correlator="%s" success="true" xmlns="urn:cisco:pnp:work-info">
    <work-response>
      <no-more-work/>
    </work-response>
  </response>
</pnp>`, correlator)
}

func pnpAckResponse() string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<pnp xmlns="urn:cisco:pnp" version="1.0">
  <response success="true" xmlns="urn:cisco:pnp:work-info">
    <work-response>
      <no-more-work/>
    </work-response>
  </response>
</pnp>`
}
