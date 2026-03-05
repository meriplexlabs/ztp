// Package auth provides JWT issuance/verification and OIDC (Azure AD) integration.
package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"time"

	oidc "github.com/coreos/go-oidc/v3/oidc"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/oauth2"

	"github.com/ztp/api/internal/models"
)

// ─── JWT ──────────────────────────────────────────────────────────────────────

type jwtClaims struct {
	jwt.RegisteredClaims
	UserID   string          `json:"uid"`
	Role     models.UserRole `json:"role"`
	Email    string          `json:"email,omitempty"`
}

// IssueJWT creates a signed JWT for the given user.
func IssueJWT(secret []byte, expiry time.Duration, user *models.User) (string, error) {
	email := ""
	if user.Email != nil {
		email = *user.Email
	}
	now := time.Now()
	claims := jwtClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   user.Username,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(expiry)),
		},
		UserID: user.ID.String(),
		Role:   user.Role,
		Email:  email,
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(secret)
}

// VerifyJWT validates a token string and returns the embedded claims.
func VerifyJWT(secret []byte, tokenStr string) (*models.Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &jwtClaims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return secret, nil
	})
	if err != nil {
		return nil, err
	}
	c, ok := token.Claims.(*jwtClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token claims")
	}
	return &models.Claims{
		UserID:   c.UserID,
		Username: c.Subject,
		Role:     c.Role,
		Email:    c.Email,
	}, nil
}

// ExtractBearerToken pulls the token string from an Authorization: Bearer <token> header.
func ExtractBearerToken(r *http.Request) string {
	hdr := r.Header.Get("Authorization")
	if strings.HasPrefix(hdr, "Bearer ") {
		return strings.TrimPrefix(hdr, "Bearer ")
	}
	// Fallback: check cookie for browser clients
	if cookie, err := r.Cookie("ztp_token"); err == nil {
		return cookie.Value
	}
	return ""
}

// ─── OIDC (Azure AD) ──────────────────────────────────────────────────────────

type OIDCProvider struct {
	provider *oidc.Provider
	oauth2   oauth2.Config
	verifier *oidc.IDTokenVerifier
}

// NewOIDCProvider initializes the OIDC provider using the issuer URL.
// For Azure AD, issuerURL = https://login.microsoftonline.com/{tenantID}/v2.0
func NewOIDCProvider(ctx context.Context, issuerURL, clientID, clientSecret, redirectURL string) (*OIDCProvider, error) {
	provider, err := oidc.NewProvider(ctx, issuerURL)
	if err != nil {
		return nil, fmt.Errorf("OIDC provider init failed: %w", err)
	}

	oauth2Cfg := oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURL:  redirectURL,
		Endpoint:     provider.Endpoint(),
		Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
	}

	verifier := provider.Verifier(&oidc.Config{ClientID: clientID})

	return &OIDCProvider{
		provider: provider,
		oauth2:   oauth2Cfg,
		verifier: verifier,
	}, nil
}

// AuthCodeURL returns the redirect URL to begin the OIDC flow, along with the state value.
func (p *OIDCProvider) AuthCodeURL() (url string, state string, err error) {
	stateBytes := make([]byte, 16)
	if _, err = rand.Read(stateBytes); err != nil {
		return
	}
	state = base64.URLEncoding.EncodeToString(stateBytes)
	url = p.oauth2.AuthCodeURL(state, oauth2.AccessTypeOnline)
	return
}

// Exchange trades an authorization code for tokens and returns the ID token claims.
func (p *OIDCProvider) Exchange(ctx context.Context, code string) (*OIDCUserInfo, error) {
	token, err := p.oauth2.Exchange(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("token exchange failed: %w", err)
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok {
		return nil, fmt.Errorf("no id_token in response")
	}

	idToken, err := p.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return nil, fmt.Errorf("id_token verification failed: %w", err)
	}

	var claims struct {
		Sub               string `json:"sub"`
		Email             string `json:"email"`
		Name              string `json:"name"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err = idToken.Claims(&claims); err != nil {
		return nil, fmt.Errorf("failed to parse ID token claims: %w", err)
	}

	username := claims.PreferredUsername
	if username == "" {
		username = claims.Email
	}

	return &OIDCUserInfo{
		Sub:      claims.Sub,
		Email:    claims.Email,
		Name:     claims.Name,
		Username: username,
	}, nil
}

type OIDCUserInfo struct {
	Sub      string
	Email    string
	Name     string
	Username string
}
