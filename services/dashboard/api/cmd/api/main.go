package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/ztp/api/internal/auth"
	cfg "github.com/ztp/api/internal/config"
	dbpkg "github.com/ztp/api/internal/db"
	"github.com/ztp/api/internal/handlers"
)

func main() {
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stdout, TimeFormat: time.RFC3339})

	// Load config
	conf, err := cfg.Load()
	if err != nil {
		log.Fatal().Err(err).Msg("Configuration error")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Database
	pool, err := dbpkg.Connect(ctx, conf.DBConnString())
	if err != nil {
		log.Fatal().Err(err).Msg("Database connection failed")
	}
	defer pool.Close()
	log.Info().Msg("Connected to database")

	// OIDC provider (optional)
	var oidcProvider *auth.OIDCProvider
	if conf.OIDCEnabled {
		oidcProvider, err = auth.NewOIDCProvider(
			ctx, conf.OIDCIssuer, conf.OIDCClientID, conf.OIDCClientSecret, conf.OIDCRedirectURL,
		)
		if err != nil {
			log.Fatal().Err(err).Msg("OIDC provider initialization failed")
		}
		log.Info().Str("issuer", conf.OIDCIssuer).Msg("OIDC enabled")
	} else {
		log.Info().Msg("OIDC disabled — local auth only")
	}

	// Handlers
	authH     := handlers.NewAuthHandler(pool, conf.JWTSecret, conf.JWTExpiry, oidcProvider)
	deviceH   := handlers.NewDeviceHandler(pool, conf.RendererURL)
	templateH := handlers.NewTemplateHandler(pool, conf.RendererURL)
	eventH    := handlers.NewEventHandler(pool)
	keaH      := handlers.NewKeaHandler(conf.KeaCtrlURL)
	settingsH := handlers.NewSettingsHandler(pool)
	pnpH      := handlers.NewPnPHandler(pool, conf.RendererURL)

	// Router
	r := chi.NewRouter()

	// Global middleware
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
	}))

	// Health check (unauthenticated)
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})

	// ─── Auth routes (unauthenticated) ─────────────────────────────────────────
	r.Route("/api/v1/auth", func(r chi.Router) {
		r.Get("/info",            authH.AuthInfo)
		r.Post("/login",          authH.LocalLogin)
		r.Get("/oidc/redirect",   authH.OIDCRedirect)
		r.Get("/oidc/callback",   authH.OIDCCallback)
	})

	// ─── ZTP config endpoint (unauthenticated — called by devices) ─────────────
	r.Get("/api/v1/config/{identifier}", deviceH.ZTPConfig)

	// ─── Cisco PnP (unauthenticated — called by devices) ───────────────────────
	r.Post("/pnp/HELLO", pnpH.Hello)
	r.Put("/pnp/HELLO", pnpH.Hello)

	// ─── Protected API routes ───────────────────────────────────────────────────
	r.Group(func(r chi.Router) {
		r.Use(handlers.JWTMiddleware(conf.JWTSecret))

		r.Get("/api/v1/auth/me",     authH.Me)
		r.Post("/api/v1/auth/logout", authH.Logout)

		// Devices
		r.Get("/api/v1/devices",              deviceH.List)
		r.Post("/api/v1/devices",             deviceH.Create)
		r.Get("/api/v1/devices/{id}",         deviceH.Get)
		r.Put("/api/v1/devices/{id}",         deviceH.Update)
		r.Delete("/api/v1/devices/{id}",      deviceH.Delete)
		r.Get("/api/v1/devices/{id}/config",  deviceH.GetConfig)

		// Templates
		r.Get("/api/v1/templates",        templateH.List)
		r.Get("/api/v1/templates/files",  templateH.ListRendererTemplates)
		r.Get("/api/v1/templates/{id}",   templateH.Get)

		// Events (syslog)
		r.Get("/api/v1/events", eventH.List)

		// DHCP (Kea proxy)
		r.Get("/api/v1/leases",       keaH.GetLeases)
		r.Get("/api/v1/dhcp/stats",   keaH.GetStats)

		// Password change (any authenticated user)
		r.Put("/api/v1/users/me/password", handlers.ChangePassword(pool))

		// Settings (read: any auth user; write: admin only)
		r.Get("/api/v1/settings", settingsH.List)
		r.Group(func(r chi.Router) {
			r.Use(handlers.RequireRole("admin"))
			r.Put("/api/v1/settings/{key}", settingsH.Update)
			r.Get("/api/v1/users", authH.ListUsers)
		})
	})

	// Start server
	server := &http.Server{
		Addr:         "0.0.0.0:" + conf.Port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Info().Str("addr", server.Addr).Msg("Dashboard API started")
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("Server error")
		}
	}()

	<-ctx.Done()
	log.Info().Msg("Shutting down...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	server.Shutdown(shutdownCtx)
}
