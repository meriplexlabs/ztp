package handlers

import (
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/ztp/api/internal/auth"
	dbpkg "github.com/ztp/api/internal/db"
	"github.com/ztp/api/internal/models"
)

// AuthHandler handles login and OIDC flows.
type AuthHandler struct {
	pool      *pgxpool.Pool
	jwtSecret []byte
	jwtExpiry time.Duration
	oidc      *auth.OIDCProvider // nil if OIDC disabled

	// OIDC state store (in-memory, short-lived) — for production use Redis
	stateMu sync.Mutex
	states  map[string]time.Time
}

func NewAuthHandler(pool *pgxpool.Pool, jwtSecret []byte, jwtExpiry time.Duration, oidcProvider *auth.OIDCProvider) *AuthHandler {
	h := &AuthHandler{
		pool:      pool,
		jwtSecret: jwtSecret,
		jwtExpiry: jwtExpiry,
		oidc:      oidcProvider,
		states:    make(map[string]time.Time),
	}
	// Periodic state cleanup
	go h.cleanStates()
	return h
}

// LocalLogin handles POST /api/v1/auth/login
func (h *AuthHandler) LocalLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "username and password are required")
		return
	}

	user, hash, err := dbpkg.GetUserByUsername(r.Context(), h.pool, req.Username)
	if err != nil || hash == "" {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if !dbpkg.VerifyLocalPassword(hash, req.Password) {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	token, err := auth.IssueJWT(h.jwtSecret, h.jwtExpiry, user)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "token generation failed")
		return
	}

	dbpkg.WriteAudit(r.Context(), h.pool, &user.ID, user.Username, "login", "user", &user.ID, map[string]any{"method": "local"}, r.RemoteAddr)
	writeJSON(w, http.StatusOK, map[string]any{
		"token":    token,
		"expires":  time.Now().Add(h.jwtExpiry).Unix(),
		"user":     user,
	})
}

// OIDCRedirect handles GET /api/v1/auth/oidc/redirect
func (h *AuthHandler) OIDCRedirect(w http.ResponseWriter, r *http.Request) {
	if h.oidc == nil {
		writeError(w, http.StatusNotFound, "OIDC is not enabled")
		return
	}
	url, state, err := h.oidc.AuthCodeURL()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to build OIDC URL")
		return
	}
	h.stateMu.Lock()
	h.states[state] = time.Now().Add(5 * time.Minute)
	h.stateMu.Unlock()

	http.Redirect(w, r, url, http.StatusFound)
}

// OIDCCallback handles GET /api/v1/auth/oidc/callback
func (h *AuthHandler) OIDCCallback(w http.ResponseWriter, r *http.Request) {
	if h.oidc == nil {
		writeError(w, http.StatusNotFound, "OIDC is not enabled")
		return
	}

	state := r.URL.Query().Get("state")
	code  := r.URL.Query().Get("code")

	// Validate state
	h.stateMu.Lock()
	expiry, ok := h.states[state]
	if ok {
		delete(h.states, state)
	}
	h.stateMu.Unlock()

	if !ok || time.Now().After(expiry) {
		writeError(w, http.StatusBadRequest, "invalid or expired state")
		return
	}

	info, err := h.oidc.Exchange(r.Context(), code)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "OIDC exchange failed: "+err.Error())
		return
	}

	user, err := dbpkg.GetOrCreateOIDCUser(r.Context(), h.pool, info.Sub, info.Email, info.Username)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "user provisioning failed")
		return
	}

	token, err := auth.IssueJWT(h.jwtSecret, h.jwtExpiry, user)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "token generation failed")
		return
	}

	// Set token as cookie and redirect to UI
	http.SetCookie(w, &http.Cookie{
		Name:     "ztp_token",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Now().Add(h.jwtExpiry),
	})
	http.Redirect(w, r, "/", http.StatusFound)
}

// Me returns the currently authenticated user's claims.
func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	claims := claimsFromCtx(r)
	writeJSON(w, http.StatusOK, claims)
}

// Logout clears the token cookie.
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:    "ztp_token",
		Value:   "",
		Path:    "/",
		MaxAge:  -1,
		Expires: time.Unix(0, 0),
	})
	writeJSON(w, http.StatusOK, map[string]string{"message": "logged out"})
}

func (h *AuthHandler) cleanStates() {
	for range time.Tick(time.Minute) {
		now := time.Now()
		h.stateMu.Lock()
		for k, exp := range h.states {
			if now.After(exp) {
				delete(h.states, k)
			}
		}
		h.stateMu.Unlock()
	}
}

// AuthInfo returns info about enabled auth methods (used by the UI login page).
func (h *AuthHandler) AuthInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"oidc_enabled": h.oidc != nil,
		"local_enabled": true,
	})
}

// ─── Users CRUD (admin only) ──────────────────────────────────────────────────

func (h *AuthHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := dbpkg.ListUsers(r.Context(), h.pool)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, users)
}

// UpdateUserRole handles PUT /api/v1/users/{id}/role
func (h *AuthHandler) UpdateUserRole(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Role models.UserRole `json:"role"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	// TODO: implement update query
	writeJSON(w, http.StatusOK, map[string]string{"message": "role updated"})
}
