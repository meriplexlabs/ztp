package handlers

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	dbpkg "github.com/ztp/api/internal/db"
)

type AuditHandler struct{ pool *pgxpool.Pool }

func NewAuditHandler(pool *pgxpool.Pool) *AuditHandler { return &AuditHandler{pool: pool} }

func (h *AuditHandler) List(w http.ResponseWriter, r *http.Request) {
	limit  := queryInt(r, "limit", 100)
	offset := queryInt(r, "offset", 0)
	entries, err := dbpkg.ListAuditLog(r.Context(), h.pool, limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, entries)
}
