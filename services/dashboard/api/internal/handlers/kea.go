// Package handlers — Kea proxy
// Forwards lease and statistics queries to the Kea Control Agent REST API.
package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
)

type KeaHandler struct {
	ctrlURL string
}

func NewKeaHandler(ctrlURL string) *KeaHandler {
	return &KeaHandler{ctrlURL: ctrlURL}
}

// GetLeases GET /api/v1/leases — proxies lease4-get-all to Kea
func (h *KeaHandler) GetLeases(w http.ResponseWriter, r *http.Request) {
	h.keaCommand(w, "lease4-get-all", map[string]any{"subnets": []int{}})
}

// GetStats GET /api/v1/dhcp/stats — proxies statistic-get-all to Kea
func (h *KeaHandler) GetStats(w http.ResponseWriter, r *http.Request) {
	h.keaCommand(w, "statistic-get-all", nil)
}

func (h *KeaHandler) keaCommand(w http.ResponseWriter, command string, args any) {
	payload := map[string]any{
		"command": command,
		"service": []string{"dhcp4"},
	}
	if args != nil {
		payload["arguments"] = args
	}
	body, _ := json.Marshal(payload)

	resp, err := http.Post(h.ctrlURL, "application/json", bytes.NewReader(body))
	if err != nil {
		writeError(w, http.StatusBadGateway, "Kea control agent unreachable")
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
