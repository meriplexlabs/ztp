package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"regexp"
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

	normalized := strings.ReplaceAll(string(out), "\r\n", "\n")
	normalized  = strings.ReplaceAll(normalized, "\r", "\n")

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, normalized)
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

// PushConfig POST /api/v1/devices/{id}/push-config
// Renders the device's config and does a full replace via SSH.
func (h *DeviceHandler) PushConfig(w http.ResponseWriter, r *http.Request) {
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

	// Render config
	config, err := h.renderConfig(r, device)
	if err != nil {
		writeError(w, http.StatusBadGateway, "render failed: "+err.Error())
		return
	}

	// Resolve management IP (same strategy as RunningConfig)
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

	// Push config via SSH
	vendor := ""
	if device.VendorClass != nil {
		vendor = *device.VendorClass
	}
	output, err := pushConfigSSH(mgmtIP, username, password, vendor, config)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"output":  strings.ReplaceAll(strings.ReplaceAll(output, "\r\n", "\n"), "\r", "\n"),
	})
}

func pushConfigSSH(mgmtIP, username, password, vendor, config string) (string, error) {
	sshCfg := &ssh.ClientConfig{
		User:            username,
		Auth:            []ssh.AuthMethod{ssh.Password(password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         15 * time.Second,
	}
	client, err := ssh.Dial("tcp", net.JoinHostPort(mgmtIP, "22"), sshCfg)
	if err != nil {
		return "", fmt.Errorf("SSH connection failed: %w", err)
	}
	defer client.Close()

	session, err := client.NewSession()
	if err != nil {
		return "", fmt.Errorf("SSH session failed: %w", err)
	}
	defer session.Close()

	var stdout bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stdout

	stdin, err := session.StdinPipe()
	if err != nil {
		return "", fmt.Errorf("stdin pipe failed: %w", err)
	}

	modes := ssh.TerminalModes{ssh.ECHO: 0, ssh.TTY_OP_ISPEED: 38400, ssh.TTY_OP_OSPEED: 38400}
	if err := session.RequestPty("xterm", 80, 200, modes); err != nil {
		return "", fmt.Errorf("PTY failed: %w", err)
	}
	if err := session.Shell(); err != nil {
		return "", fmt.Errorf("shell failed: %w", err)
	}
	time.Sleep(1 * time.Second)

	send := func(line string, delay time.Duration) {
		fmt.Fprintf(stdin, "%s\n", line)
		time.Sleep(delay)
	}

	lines := strings.Split(strings.ReplaceAll(config, "\r\n", "\n"), "\n")

	switch vendor {
	case "juniper":
		send("configure exclusive", 800*time.Millisecond)
		send("load override terminal", 300*time.Millisecond)
		for _, line := range lines {
			fmt.Fprintf(stdin, "%s\n", line)
			time.Sleep(20 * time.Millisecond)
		}
		stdin.Write([]byte{4}) // Ctrl+D — end terminal input
		time.Sleep(1 * time.Second)
		send("commit and-quit", 3*time.Second)

	default: // cisco, aruba, extreme, fortinet
		send("configure terminal", 500*time.Millisecond)
		for _, line := range lines {
			line = strings.TrimRight(line, " \t")
			if line == "" || strings.HasPrefix(line, "!") || strings.HasPrefix(line, "#") {
				continue
			}
			fmt.Fprintf(stdin, "%s\n", line)
			time.Sleep(80 * time.Millisecond)
		}
		send("end", 300*time.Millisecond)
		send("write memory", 3*time.Second)
	}

	stdin.Close()
	session.Wait()
	return stdout.String(), nil
}

// FirmwareVersion POST /api/v1/devices/{id}/firmware-version
// SSHes to the device, runs "show version", parses the version string, stores it in the DB, returns it.
func (h *DeviceHandler) FirmwareVersion(w http.ResponseWriter, r *http.Request) {
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

	// Resolve management IP
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

	vendor := ""
	if device.VendorClass != nil {
		vendor = strings.ToLower(*device.VendorClass)
	}

	version, err := detectFirmwareVersion(mgmtIP, username, password, vendor)
	if err != nil {
		writeError(w, http.StatusBadGateway, "firmware detection failed: "+err.Error())
		return
	}

	if err := dbpkg.UpdateDeviceFirmware(ctx, h.pool, id, version); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save firmware version: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"firmware_version": version})
}

func detectFirmwareVersion(mgmtIP, username, password, vendor string) (string, error) {
	sshCfg := &ssh.ClientConfig{
		User:            username,
		Auth:            []ssh.AuthMethod{ssh.Password(password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         15 * time.Second,
	}
	client, err := ssh.Dial("tcp", net.JoinHostPort(mgmtIP, "22"), sshCfg)
	if err != nil {
		return "", fmt.Errorf("SSH connection failed: %w", err)
	}
	defer client.Close()

	session, err := client.NewSession()
	if err != nil {
		return "", fmt.Errorf("SSH session failed: %w", err)
	}
	defer session.Close()

	out, err := session.Output("show version")
	if err != nil {
		return "", fmt.Errorf("show version failed: %w", err)
	}
	output := string(out)

	return parseVersionString(vendor, output), nil
}

// parseVersionString extracts a version from "show version" output using vendor-specific patterns.
func parseVersionString(vendor, output string) string {
	patterns := []string{}
	switch vendor {
	case "cisco", "cisco_ios", "cisco_ios-xe":
		// "Cisco IOS Software, Version 15.2(7)E4" or "Cisco IOS XE Software, Version 17.3.4"
		patterns = []string{`(?i)Version\s+(\S+),`, `(?i)Version\s+(\S+)`}
	case "juniper", "junos":
		// "Junos: 21.4R3.15" (modern) or "JUNOS 21.4R3-S1.4" (older)
		patterns = []string{`(?i)Junos:\s+(\S+)`, `(?i)JUNOS\s+(\d\S+)`}
	case "aruba", "hp", "hpe":
		// "WC.16.11.0010" or "revision H.16.02.0025"
		patterns = []string{`(?i)revision\s+(\S+)`, `(?i)Software revision\s+(\S+)`, `[A-Z]{1,3}\.\d+\.\d+\.\d+`}
	case "extreme":
		// "ExtremeXOS version 31.7.1.4"
		patterns = []string{`(?i)version\s+(\d[\d.]+)`}
	case "fortinet":
		// "FortiOS v7.4.3"
		patterns = []string{`(?i)FortiOS\s+v?(\S+)`, `(?i)Version\s*:\s*v?(\S+)`}
	default:
		patterns = []string{`(?i)(?:software\s+)?[Vv]ersion[:\s]+v?(\S+)`}
	}

	for _, pat := range patterns {
		if m := regexpFind(pat, output); m != "" {
			return m
		}
	}
	return "unknown"
}

func regexpFind(pattern, text string) string {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return ""
	}
	sub := re.FindStringSubmatch(text)
	if len(sub) > 1 {
		return strings.TrimRight(sub[1], ",;")
	}
	if len(sub) == 1 {
		return strings.TrimRight(sub[0], ",;")
	}
	return ""
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
