package handlers

import (
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	dbpkg "github.com/ztp/api/internal/db"
)

// envDefaults maps setting keys to their env var names.
// When a setting has no DB value, the env var (or this hardcoded fallback) is returned.
var envDefaults = map[string][2]string{
	// key: [envVarName, hardcodedDefault]
	"ztp.domain":         {"ZTP_DOMAIN", "ztp.local"},
	"ztp.tftp_server":    {"TFTP_SERVER", ""},
	"ztp.api_base_url":   {"API_BASE_URL", ""},
	"snmp.auth_protocol": {"SNMP_AUTH_PROTOCOL", "SHA"},
	"snmp.priv_protocol": {"SNMP_PRIV_PROTOCOL", "AES"},
	"snmp.location":      {"SNMP_LOCATION", ""},
	"kea.ctrl_agent_url": {"KEA_CTRL_AGENT_URL", "http://localhost:8000"},
	"kea.dhcp_interface": {"KEA_DHCP_INTERFACE", "eth0"},
}

type SettingsHandler struct {
	pool *pgxpool.Pool
}

func NewSettingsHandler(pool *pgxpool.Pool) *SettingsHandler {
	return &SettingsHandler{pool: pool}
}

// List handles GET /api/v1/settings
// Returns all settings; DB value takes priority, falls back to env var then hardcoded default.
func (h *SettingsHandler) List(w http.ResponseWriter, r *http.Request) {
	settings, err := dbpkg.ListSettings(r.Context(), h.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Merge env defaults into nil-value settings
	type settingResponse struct {
		dbpkg.Setting
		EffectiveValue string `json:"effective_value"`
		Source         string `json:"source"` // "db" | "env" | "default"
	}

	out := make([]settingResponse, 0, len(settings))
	for _, s := range settings {
		sr := settingResponse{Setting: s}
		if s.Value != nil {
			sr.EffectiveValue = *s.Value
			sr.Source = "db"
		} else if def, ok := envDefaults[s.Key]; ok {
			if v := os.Getenv(def[0]); v != "" {
				sr.EffectiveValue = v
				sr.Source = "env"
			} else {
				sr.EffectiveValue = def[1]
				sr.Source = "default"
			}
		}
		out = append(out, sr)
	}

	writeJSON(w, http.StatusOK, out)
}

// Update handles PUT /api/v1/settings/{key}
func (h *SettingsHandler) Update(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")

	var req struct {
		Value *string `json:"value"` // null = clear (revert to env/default)
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	claims := claimsFromCtx(r)
	userID, err := uuid.Parse(claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "invalid user ID in token")
		return
	}

	if req.Value == nil {
		if err := dbpkg.ClearSetting(r.Context(), h.pool, key); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	} else {
		if err := dbpkg.SetSetting(r.Context(), h.pool, key, *req.Value, userID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "setting updated"})
}

// ─── Password Change ──────────────────────────────────────────────────────────

// ChangePassword handles PUT /api/v1/users/me/password
func ChangePassword(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			CurrentPassword string `json:"current_password"`
			NewPassword     string `json:"new_password"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if req.CurrentPassword == "" || req.NewPassword == "" {
			writeError(w, http.StatusBadRequest, "current_password and new_password are required")
			return
		}
		if len(req.NewPassword) < 8 {
			writeError(w, http.StatusBadRequest, "new password must be at least 8 characters")
			return
		}

		claims := claimsFromCtx(r)

		// Re-fetch current hash to verify current password
		_, currentHash, err := dbpkg.GetUserByUsername(r.Context(), pool, claims.Username)
		if err != nil || currentHash == "" {
			writeError(w, http.StatusUnauthorized, "user not found")
			return
		}
		if !dbpkg.VerifyLocalPassword(currentHash, req.CurrentPassword) {
			writeError(w, http.StatusUnauthorized, "current password is incorrect")
			return
		}

		newHash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), 12)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to hash password")
			return
		}

		userID, _ := uuid.Parse(claims.UserID)
		if err := dbpkg.ChangePassword(r.Context(), pool, userID, string(newHash)); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update password")
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{"message": "password updated"})
	}
}
