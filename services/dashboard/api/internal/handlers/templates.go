package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	dbpkg "github.com/ztp/api/internal/db"
)

type TemplateHandler struct {
	pool        *pgxpool.Pool
	rendererURL string
}

func NewTemplateHandler(pool *pgxpool.Pool, rendererURL string) *TemplateHandler {
	return &TemplateHandler{pool: pool, rendererURL: rendererURL}
}

// List GET /api/v1/templates
func (h *TemplateHandler) List(w http.ResponseWriter, r *http.Request) {
	templates, err := dbpkg.ListTemplates(r.Context(), h.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, templates)
}

// Get GET /api/v1/templates/{id}
func (h *TemplateHandler) Get(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid template ID")
		return
	}
	tmpl, err := dbpkg.GetTemplate(r.Context(), h.pool, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "template not found")
		return
	}
	writeJSON(w, http.StatusOK, tmpl)
}

// ListRendererTemplates GET /api/v1/templates/files
// Returns template files available in the renderer's template directory.
func (h *TemplateHandler) ListRendererTemplates(w http.ResponseWriter, r *http.Request) {
	resp, err := http.Get(h.rendererURL + "/templates")
	if err != nil {
		writeError(w, http.StatusBadGateway, "renderer unreachable")
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	// Proxy the response directly
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			w.Write(buf[:n])
		}
		if err != nil {
			break
		}
	}
}
