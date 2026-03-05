package handlers

import (
	"context"
	"net/http"

	"github.com/ztp/api/internal/auth"
	"github.com/ztp/api/internal/models"
)

type contextKey string

const claimsKey contextKey = "claims"

// JWTMiddleware validates the Bearer token and injects claims into the request context.
func JWTMiddleware(secret []byte) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := auth.ExtractBearerToken(r)
			if token == "" {
				writeError(w, http.StatusUnauthorized, "missing or invalid authorization token")
				return
			}
			claims, err := auth.VerifyJWT(secret, token)
			if err != nil {
				writeError(w, http.StatusUnauthorized, "invalid or expired token")
				return
			}
			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireRole returns a middleware that enforces a minimum role.
func RequireRole(role models.UserRole) func(http.Handler) http.Handler {
	roleRank := map[models.UserRole]int{
		models.RoleViewer: 0,
		models.RoleEditor: 1,
		models.RoleAdmin:  2,
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims := claimsFromCtx(r)
			if claims == nil || roleRank[claims.Role] < roleRank[role] {
				writeError(w, http.StatusForbidden, "insufficient permissions")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func claimsFromCtx(r *http.Request) *models.Claims {
	c, _ := r.Context().Value(claimsKey).(*models.Claims)
	return c
}
