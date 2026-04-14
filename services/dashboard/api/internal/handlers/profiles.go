package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	dbpkg "github.com/ztp/api/internal/db"
	"github.com/ztp/api/internal/models"
)

type ProfileHandler struct {
	pool *pgxpool.Pool
}

func NewProfileHandler(pool *pgxpool.Pool) *ProfileHandler {
	return &ProfileHandler{pool: pool}
}

// List GET /api/v1/profiles
func (h *ProfileHandler) List(w http.ResponseWriter, r *http.Request) {
	profiles, err := dbpkg.ListProfiles(r.Context(), h.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if profiles == nil {
		profiles = []models.DeviceProfile{}
	}
	writeJSON(w, http.StatusOK, profiles)
}

// Get GET /api/v1/profiles/{id}
func (h *ProfileHandler) Get(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile ID")
		return
	}
	profile, err := dbpkg.GetProfile(r.Context(), h.pool, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "profile not found")
		return
	}
	writeJSON(w, http.StatusOK, profile)
}

// Create POST /api/v1/profiles
func (h *ProfileHandler) Create(w http.ResponseWriter, r *http.Request) {
	var p models.DeviceProfile
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if p.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if p.Variables == nil {
		p.Variables = map[string]any{}
	}
	if err := dbpkg.CreateProfile(r.Context(), h.pool, &p); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create profile: "+err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

// Update PUT /api/v1/profiles/{id}
func (h *ProfileHandler) Update(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile ID")
		return
	}
	var p models.DeviceProfile
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	p.ID = id
	if p.Variables == nil {
		p.Variables = map[string]any{}
	}
	if err := dbpkg.UpdateProfile(r.Context(), h.pool, &p); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update profile: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// Delete DELETE /api/v1/profiles/{id}
func (h *ProfileHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid profile ID")
		return
	}
	if err := dbpkg.DeleteProfile(r.Context(), h.pool, id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete profile: "+err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
