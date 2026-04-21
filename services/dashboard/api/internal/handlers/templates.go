package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	dbpkg "github.com/ztp/api/internal/db"
	"github.com/ztp/api/internal/gitops"
	"github.com/ztp/api/internal/models"
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

// Create POST /api/v1/templates
func (h *TemplateHandler) Create(w http.ResponseWriter, r *http.Request) {
	var t models.ConfigTemplate
	if err := decodeJSON(r, &t); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if t.Name == "" || t.Vendor == "" || t.OSType == "" {
		writeError(w, http.StatusBadRequest, "name, vendor, and os_type are required")
		return
	}
	if t.FilePath == nil && t.Content == nil {
		writeError(w, http.StatusBadRequest, "either file_path or content must be provided")
		return
	}
	if t.Variables == nil {
		t.Variables = []models.TemplateVar{}
	}
	if err := dbpkg.CreateTemplate(r.Context(), h.pool, &t); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create template: "+err.Error())
		return
	}
	go gitops.CommitTemplate(context.Background(), h.pool, &t)
	writeJSON(w, http.StatusCreated, t)
}

// Update PUT /api/v1/templates/{id}
func (h *TemplateHandler) Update(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid template ID")
		return
	}
	var t models.ConfigTemplate
	if err := decodeJSON(r, &t); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	t.ID = id
	if t.Variables == nil {
		t.Variables = []models.TemplateVar{}
	}
	if err := dbpkg.UpdateTemplate(r.Context(), h.pool, &t); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update template: "+err.Error())
		return
	}
	go gitops.CommitTemplate(context.Background(), h.pool, &t)
	writeJSON(w, http.StatusOK, t)
}

// Delete DELETE /api/v1/templates/{id}
func (h *TemplateHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid template ID")
		return
	}
	if err := dbpkg.DeleteTemplate(r.Context(), h.pool, id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete template: "+err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Variables GET /api/v1/templates/{id}/variables
// Calls the renderer to extract all Jinja2 variable names used in the template.
func (h *TemplateHandler) Variables(w http.ResponseWriter, r *http.Request) {
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

	var payload map[string]any
	if tmpl.Content != nil && *tmpl.Content != "" {
		payload = map[string]any{"content": *tmpl.Content}
	} else {
		name := tmpl.Vendor + "/" + tmpl.OSType
		if tmpl.FilePath != nil {
			fp := *tmpl.FilePath
			if len(fp) > 4 && fp[len(fp)-4:] == ".cfg" {
				fp = fp[:len(fp)-4]
			}
			name = fp
		}
		payload = map[string]any{"template_name": name}
	}

	body, _ := json.Marshal(payload)
	resp, err := http.Post(h.rendererURL+"/variables", "application/json", bytes.NewReader(body))
	if err != nil {
		writeError(w, http.StatusBadGateway, "renderer unreachable")
		return
	}
	defer resp.Body.Close()

	var result struct {
		Variables []string `json:"variables"`
		Detail    string   `json:"detail"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		writeError(w, http.StatusBadGateway, "invalid renderer response")
		return
	}
	if resp.StatusCode != http.StatusOK {
		writeError(w, http.StatusBadGateway, "renderer error: "+result.Detail)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"variables": result.Variables})
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
