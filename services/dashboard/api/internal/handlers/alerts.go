package handlers

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	dbpkg "github.com/ztp/api/internal/db"
)

type AlertHandler struct{ pool *pgxpool.Pool }

func NewAlertHandler(pool *pgxpool.Pool) *AlertHandler { return &AlertHandler{pool: pool} }

// List GET /api/v1/alerts — returns unresolved by default; ?all=true for everything
func (h *AlertHandler) List(w http.ResponseWriter, r *http.Request) {
	all := r.URL.Query().Get("all") == "true"
	alerts, err := dbpkg.ListAlerts(r.Context(), h.pool, all)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, alerts)
}

// Count GET /api/v1/alerts/count — lightweight unresolved count for the bell badge
func (h *AlertHandler) Count(w http.ResponseWriter, r *http.Request) {
	n, err := dbpkg.CountUnresolvedAlerts(r.Context(), h.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"count": n})
}

// Resolve POST /api/v1/alerts/{id}/resolve
func (h *AlertHandler) Resolve(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid alert ID")
		return
	}
	if err := dbpkg.ResolveAlert(r.Context(), h.pool, id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"resolved": true})
}
