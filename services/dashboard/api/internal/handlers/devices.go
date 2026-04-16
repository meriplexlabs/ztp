package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/ssh"

	dbpkg "github.com/ztp/api/internal/db"
	"github.com/ztp/api/internal/models"
)

type DeviceHandler struct {
	pool        *pgxpool.Pool
	rendererURL string
}

func NewDeviceHandler(pool *pgxpool.Pool, rendererURL string) *DeviceHandler {
	return &DeviceHandler{pool: pool, rendererURL: rendererURL}
}

// List GET /api/v1/devices
func (h *DeviceHandler) List(w http.ResponseWriter, r *http.Request) {
	devices, err := dbpkg.ListDevices(r.Context(), h.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if devices == nil {
		devices = []models.Device{}
	}
	writeJSON(w, http.StatusOK, devices)
}

// Get GET /api/v1/devices/{id}
func (h *DeviceHandler) Get(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid device ID")
		return
	}
	device, err := dbpkg.GetDevice(r.Context(), h.pool, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "device not found")
		return
	}
	writeJSON(w, http.StatusOK, device)
}

// Create POST /api/v1/devices
func (h *DeviceHandler) Create(w http.ResponseWriter, r *http.Request) {
	var device models.Device
	if err := decodeJSON(r, &device); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if device.MAC == nil && device.Serial == nil {
		writeError(w, http.StatusBadRequest, "at least one of mac or serial must be provided")
		return
	}
	if err := dbpkg.CreateDevice(r.Context(), h.pool, &device); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create device: "+err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, device)
}

// Update PUT /api/v1/devices/{id}
func (h *DeviceHandler) Update(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid device ID")
		return
	}
	var device models.Device
	if err := decodeJSON(r, &device); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	device.ID = id
	if err := dbpkg.UpdateDevice(r.Context(), h.pool, &device); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update device: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, device)
}

// Delete DELETE /api/v1/devices/{id}
func (h *DeviceHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid device ID")
		return
	}
	if err := dbpkg.DeleteDevice(r.Context(), h.pool, id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete device: "+err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetConfig GET /api/v1/devices/{id}/config
// Fetches the device record, resolves its template + merged variables, calls the renderer.
func (h *DeviceHandler) GetConfig(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid device ID")
		return
	}
	device, err := dbpkg.GetDevice(r.Context(), h.pool, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "device not found")
		return
	}
	config, err := h.renderConfig(r, device)
	if err != nil {
		writeError(w, http.StatusBadGateway, "render failed: "+err.Error())
		return
	}

	// Return as plain text (device-friendly) or JSON depending on Accept header
	if strings.Contains(r.Header.Get("Accept"), "application/json") {
		writeJSON(w, http.StatusOK, map[string]string{"config": config})
	} else {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, config)
	}
}

// RunningConfig GET /api/v1/devices/{id}/running-config
// SSHes to the device and returns its current running configuration.
func (h *DeviceHandler) RunningConfig(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid device ID")
		return
	}
	ctx := r.Context()
	device, err := dbpkg.GetDevice(ctx, h.pool, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "device not found")
		return
	}

	// Resolve management IP (same strategy as terminal handler)
	var mgmtIP string
	ipQuery := `
		SELECT
			((address >> 24) & 255)::text || '.' ||
			((address >> 16) & 255)::text || '.' ||
			((address >> 8)  & 255)::text || '.' ||
			(address         & 255)::text
		FROM lease4
		WHERE %s AND state = 0
		LIMIT 1
	`
	if device.Hostname != nil {
		row := h.pool.QueryRow(ctx, fmt.Sprintf(ipQuery, "LOWER(hostname) = LOWER($1)"), *device.Hostname)
		_ = row.Scan(&mgmtIP)
	}
	if mgmtIP == "" && device.Serial != nil {
		row := h.pool.QueryRow(ctx, fmt.Sprintf(ipQuery, "LOWER(hostname) = LOWER($1)"), *device.Serial)
		_ = row.Scan(&mgmtIP)
	}
	if mgmtIP == "" && device.MAC != nil {
		mac := strings.ReplaceAll(*device.MAC, ":", "")
		row := h.pool.QueryRow(ctx, fmt.Sprintf(ipQuery, "encode(hwaddr, 'hex') = $1"), mac)
		_ = row.Scan(&mgmtIP)
	}
	if mgmtIP == "" {
		writeError(w, http.StatusBadRequest, "no active DHCP lease — management IP unknown")
		return
	}

	// Resolve SSH credentials
	merged := map[string]any{}
	if device.ProfileID != nil {
		if profile, err := dbpkg.GetProfile(ctx, h.pool, *device.ProfileID); err == nil {
			for k, v := range profile.Variables {
				merged[k] = v
			}
		}
	}
	for k, v := range device.Variables {
		merged[k] = v
	}
	username := "admin"
	if u, _ := merged["ssh_username"].(string); u != "" {
		username = u
	}
	password, _ := merged["local_password"].(string)
	if password == "" {
		writeError(w, http.StatusBadRequest, "local_password not set on device or profile")
		return
	}

	// Determine show command by vendor
	showCmd := "show running-config"
	if device.VendorClass != nil {
		switch *device.VendorClass {
		case "juniper":
			showCmd = "show configuration | no-more"
		case "aruba":
			showCmd = "show running-config"
		}
	}

	sshCfg := &ssh.ClientConfig{
		User:            username,
		Auth:            []ssh.AuthMethod{ssh.Password(password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         15 * time.Second,
	}
	client, err := ssh.Dial("tcp", net.JoinHostPort(mgmtIP, "22"), sshCfg)
	if err != nil {
		writeError(w, http.StatusBadGateway, "SSH connection failed: "+err.Error())
		return
	}
	defer client.Close()

	session, err := client.NewSession()
	if err != nil {
		writeError(w, http.StatusBadGateway, "SSH session failed: "+err.Error())
		return
	}
	defer session.Close()

	out, err := session.Output(showCmd)
	if err != nil {
		writeError(w, http.StatusBadGateway, "command failed: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write(out)
}

// ZTPConfig GET /api/v1/config/{identifier}
// This is the unauthenticated endpoint devices call during ZTP.
func (h *DeviceHandler) ZTPConfig(w http.ResponseWriter, r *http.Request) {
	identifier := chi.URLParam(r, "identifier")
	device, err := dbpkg.GetDeviceByIdentifier(r.Context(), h.pool, identifier)
	if err != nil {
		writeError(w, http.StatusNotFound, "device not registered")
		return
	}

	// Update device status to provisioning
	device.Status = models.StatusProvisioning
	_ = dbpkg.UpdateDevice(r.Context(), h.pool, device)

	config, err := h.renderConfig(r, device)
	if err != nil {
		writeError(w, http.StatusBadGateway, "render failed: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, config)
}

// renderConfig calls the Python renderer service.
func (h *DeviceHandler) renderConfig(r *http.Request, device *models.Device) (string, error) {
	if device.ProfileID == nil {
		return "", fmt.Errorf("device has no profile assigned")
	}

	profile, err := dbpkg.GetProfile(r.Context(), h.pool, *device.ProfileID)
	if err != nil {
		return "", fmt.Errorf("profile not found: %w", err)
	}
	if profile.TemplateID == nil {
		return "", fmt.Errorf("profile has no template assigned")
	}

	template, err := dbpkg.GetTemplate(r.Context(), h.pool, *profile.TemplateID)
	if err != nil {
		return "", fmt.Errorf("template not found: %w", err)
	}

	// Merge variables: template defaults < profile vars < device vars
	// Device fields are also injected so templates can reference them directly.
	merged := map[string]any{}
	for k, v := range profile.Variables {
		merged[k] = v
	}
	for k, v := range device.Variables {
		merged[k] = v
	}
	// Auto-inject device fields (explicit variables above take precedence)
	if device.Serial != nil {
		if _, ok := merged["serial"]; !ok {
			merged["serial"] = *device.Serial
		}
	}
	if device.MAC != nil {
		if _, ok := merged["mac"]; !ok {
			merged["mac"] = *device.MAC
		}
	}
	if device.Hostname != nil {
		if _, ok := merged["hostname"]; !ok {
			merged["hostname"] = *device.Hostname
		}
	}

	// Determine template name for renderer
	templateName := fmt.Sprintf("%s/%s", template.Vendor, template.OSType)
	if template.FilePath != nil {
		// Strip .cfg suffix if present
		templateName = strings.TrimSuffix(*template.FilePath, ".cfg")
	}

	payload := map[string]any{
		"template_name": templateName,
		"variables":     merged,
	}
	body, _ := json.Marshal(payload)

	resp, err := http.Post(h.rendererURL+"/render", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("renderer unreachable: %w", err)
	}
	defer resp.Body.Close()

	var result struct {
		Config string `json:"config"`
		Detail string `json:"detail"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("invalid renderer response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("renderer error: %s", result.Detail)
	}
	return result.Config, nil
}
