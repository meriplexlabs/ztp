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

// List GET /api/v1/events
func (h *EventHandler) List(w http.ResponseWriter, r *http.Request) {
	limit  := queryInt(r, "limit", 100)
	offset := queryInt(r, "offset", 0)
	if limit > 500 {
		limit = 500
	}
	events, err := dbpkg.ListEvents(r.Context(), h.pool, limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, events)
}
