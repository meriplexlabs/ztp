package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
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
	merged := map[string]any{}
	for k, v := range profile.Variables {
		merged[k] = v
	}
	for k, v := range device.Variables {
		merged[k] = v
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
