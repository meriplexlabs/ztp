package handlers

import (
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ztp/api/internal/gitops"
)

type GitHandler struct {
	pool *pgxpool.Pool
}

func NewGitHandler(pool *pgxpool.Pool) *GitHandler {
	return &GitHandler{pool: pool}
}

// SyncTemplates POST /api/v1/git/sync-templates
// Clones the configured template repo and upserts matching .cfg/.j2 files into the DB.
func (h *GitHandler) SyncTemplates(w http.ResponseWriter, r *http.Request) {
	count, err := gitops.SyncTemplates(r.Context(), h.pool)
	if err != nil {
		writeError(w, http.StatusBadGateway, "git sync failed: "+err.Error())
		return
	}
	auditUser(r, h.pool, claimsFromCtx(r), "git_sync_templates", "template", nil,
		map[string]any{"count": count})
	writeJSON(w, http.StatusOK, map[string]any{
		"synced": count,
		"message": fmt.Sprintf("%d template(s) synced from git", count),
	})
}
