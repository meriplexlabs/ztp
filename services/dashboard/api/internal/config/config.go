package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds all application configuration loaded from environment variables.
type Config struct {
	// Server
	Port string

	// Database
	DBHost     string
	DBPort     int
	DBName     string
	DBUser     string
	DBPassword string

	// JWT
	JWTSecret []byte
	JWTExpiry time.Duration

	// OIDC / Azure AD
	OIDCEnabled     bool
	OIDCIssuer      string
	OIDCClientID    string
	OIDCClientSecret string
	OIDCRedirectURL string

	// Renderer service
	RendererURL string

	// Kea control agent
	KeaCtrlURL string
}

func Load() (*Config, error) {
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET must be set")
	}

	jwtExpiry, err := time.ParseDuration(getEnv("JWT_EXPIRY", "24h"))
	if err != nil {
		return nil, fmt.Errorf("invalid JWT_EXPIRY: %w", err)
	}

	dbPort, err := strconv.Atoi(getEnv("POSTGRES_PORT", "5432"))
	if err != nil {
		return nil, fmt.Errorf("invalid POSTGRES_PORT: %w", err)
	}

	oidcEnabled, _ := strconv.ParseBool(getEnv("OIDC_ENABLED", "false"))

	return &Config{
		Port:             getEnv("API_PORT", "8080"),
		DBHost:           getEnv("POSTGRES_HOST", "localhost"),
		DBPort:           dbPort,
		DBName:           getEnv("POSTGRES_DB", "ztp"),
		DBUser:           getEnv("POSTGRES_USER", "ztp"),
		DBPassword:       getEnv("POSTGRES_PASSWORD", "changeme"),
		JWTSecret:        []byte(jwtSecret),
		JWTExpiry:        jwtExpiry,
		OIDCEnabled:      oidcEnabled,
		OIDCIssuer:       os.Getenv("OIDC_ISSUER"),
		OIDCClientID:     os.Getenv("OIDC_CLIENT_ID"),
		OIDCClientSecret: os.Getenv("OIDC_CLIENT_SECRET"),
		OIDCRedirectURL:  os.Getenv("OIDC_REDIRECT_URL"),
		RendererURL:      getEnv("RENDERER_URL", "http://localhost:8001"),
		KeaCtrlURL:       getEnv("KEA_CTRL_AGENT_URL", "http://localhost:8000"),
	}, nil
}

func (c *Config) DBConnString() string {
	return fmt.Sprintf(
		"host=%s port=%d dbname=%s user=%s password=%s sslmode=disable",
		c.DBHost, c.DBPort, c.DBName, c.DBUser, c.DBPassword,
	)
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
