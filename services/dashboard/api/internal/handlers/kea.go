// Package handlers — Kea lease data via direct PostgreSQL query.
// Kea writes leases to the shared Postgres DB (lease4 table).
// Querying it directly is more reliable than going through the Kea Control Agent.
package handlers

import (
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
)

type KeaHandler struct {
	pool    *pgxpool.Pool
	ctrlURL string // retained for future use
}

func NewKeaHandler(pool *pgxpool.Pool, ctrlURL string) *KeaHandler {
	return &KeaHandler{pool: pool, ctrlURL: ctrlURL}
}

type dbLease struct {
	IPAddress string `json:"ip_address"`
	HWAddress string `json:"hw_address"`
	Hostname  string `json:"hostname"`
	SubnetID  int64  `json:"subnet_id"`
	State     int64  `json:"state"`
	ValidLft  int64  `json:"valid_lft"`
}

// GetLeases GET /api/v1/leases — reads lease4 from Postgres directly.
func (h *KeaHandler) GetLeases(w http.ResponseWriter, r *http.Request) {
	rows, err := h.pool.Query(r.Context(), `
		SELECT
			((address >> 24) & 255)::text || '.' ||
			((address >> 16) & 255)::text || '.' ||
			((address >> 8)  & 255)::text || '.' ||
			(address         & 255)::text  AS ip_address,
			hwaddr,
			COALESCE(hostname, '')         AS hostname,
			subnet_id,
			state,
			valid_lifetime                 AS valid_lft
		FROM lease4
		ORDER BY address
	`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "lease query failed: "+err.Error())
		return
	}
	defer rows.Close()

	leases := []dbLease{}
	for rows.Next() {
		var l dbLease
		var hwaddr []byte
		if err := rows.Scan(&l.IPAddress, &hwaddr, &l.Hostname, &l.SubnetID, &l.State, &l.ValidLft); err != nil {
			continue
		}
		if len(hwaddr) == 6 {
			l.HWAddress = fmt.Sprintf("%02x:%02x:%02x:%02x:%02x:%02x",
				hwaddr[0], hwaddr[1], hwaddr[2], hwaddr[3], hwaddr[4], hwaddr[5])
		}
		leases = append(leases, l)
	}
	writeJSON(w, http.StatusOK, leases)
}

// GetStats GET /api/v1/dhcp/stats — stub; full stats require Kea control agent.
func (h *KeaHandler) GetStats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{})
}
