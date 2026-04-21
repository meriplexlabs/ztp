package handlers

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	dbpkg "github.com/ztp/api/internal/db"
)

type EventHandler struct {
	pool *pgxpool.Pool
}

func NewEventHandler(pool *pgxpool.Pool) *EventHandler {
	return &EventHandler{pool: pool}
}

// Sources GET /api/v1/events/sources — distinct source IPs with device label
func (h *EventHandler) Sources(w http.ResponseWriter, r *http.Request) {
	rows, err := h.pool.Query(r.Context(),
		`SELECT DISTINCT ON (e.source_ip) e.source_ip::text,
		        COALESCE(d.hostname, d.serial, d.mac::text, d.id::text) AS label
		 FROM syslog_events e
		 LEFT JOIN dhcp_reservations r ON r.ip_address = e.source_ip
		 LEFT JOIN devices d ON d.id = r.device_id
		 ORDER BY e.source_ip`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	type source struct {
		IP    string  `json:"source_ip"`
		Label *string `json:"label"`
	}
	var sources []source
	for rows.Next() {
		var s source
		if err := rows.Scan(&s.IP, &s.Label); err != nil {
			continue
		}
		sources = append(sources, s)
	}
	if sources == nil {
		sources = []source{}
	}
	writeJSON(w, http.StatusOK, sources)
}

// List GET /api/v1/events
func (h *EventHandler) List(w http.ResponseWriter, r *http.Request) {
	limit    := queryInt(r, "limit", 100)
	offset   := queryInt(r, "offset", 0)
	deviceID := r.URL.Query().Get("device_id")
	if limit > 500 {
		limit = 500
	}
	events, err := dbpkg.ListEvents(r.Context(), h.pool, limit, offset, deviceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, events)
}
