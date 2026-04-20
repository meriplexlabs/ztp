package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	dbpkg "github.com/ztp/api/internal/db"
	"github.com/ztp/api/internal/models"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func decodeJSON(r *http.Request, v any) error {
	return json.NewDecoder(r.Body).Decode(v)
}

// auditUser writes an audit log entry using the authenticated user from JWT claims.
func auditUser(r *http.Request, pool *pgxpool.Pool, claims *models.Claims, action, entityType string, entityID *uuid.UUID, payload map[string]any) {
	var userID *uuid.UUID
	var username string
	if claims != nil {
		if id, err := uuid.Parse(claims.UserID); err == nil {
			userID = &id
		}
		username = claims.Username
	}
	dbpkg.WriteAudit(r.Context(), pool, userID, username, action, entityType, entityID, payload, r.RemoteAddr)
}

func queryInt(r *http.Request, key string, fallback int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}
