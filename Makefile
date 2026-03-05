# ZTP Server - Makefile
# Usage: make <target>

.PHONY: help up down dev logs ps build pull \
        run-api run-ui run-renderer run-syslog \
        db-start db-migrate db-shell \
        lint test clean

# Load .env if it exists
-include .env
export

COMPOSE        := docker compose
COMPOSE_DEV    := $(COMPOSE) -f docker-compose.yml -f docker-compose.dev.yml
API_DIR        := services/dashboard/api
UI_DIR         := services/dashboard/ui
RENDERER_DIR   := services/renderer
SYSLOG_DIR     := services/syslog

# ─── Docker targets ───────────────────────────────────────────────────────────

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

up: ## Start all services (production compose)
	$(COMPOSE) up -d

down: ## Stop and remove all containers
	$(COMPOSE) down

dev: ## Start all services in dev mode (hot reload + debug ports)
	$(COMPOSE_DEV) up

logs: ## Follow logs for all services
	$(COMPOSE) logs -f

ps: ## Show running containers
	$(COMPOSE) ps

build: ## Build all images
	$(COMPOSE) build

pull: ## Pull latest base images
	$(COMPOSE) pull

# ─── Database targets ─────────────────────────────────────────────────────────

db-start: ## Start only the postgres container
	$(COMPOSE) up -d postgres

db-shell: ## Open a psql shell
	$(COMPOSE) exec postgres psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

db-migrate: ## Re-apply init SQL (destroys and recreates schema!)
	@echo "WARNING: This will reset the database schema. Press Ctrl-C to abort."
	@sleep 3
	$(COMPOSE) exec postgres psql -U $(POSTGRES_USER) -d $(POSTGRES_DB) \
		-f /docker-entrypoint-initdb.d/01-schema.sql \
		-f /docker-entrypoint-initdb.d/02-seed.sql

# ─── Native dev targets (no Docker) ──────────────────────────────────────────

run-api: db-start ## Run the Go API locally (requires Go 1.23+)
	@echo "Starting Dashboard API on port $(API_PORT)..."
	cd $(API_DIR) && go run ./cmd/api/main.go

run-ui: ## Run the React UI locally (requires Node 20+)
	@echo "Starting React UI dev server..."
	cd $(UI_DIR) && npm run dev

run-renderer: ## Run the Python renderer locally (requires Python 3.12+)
	@echo "Starting Renderer on port $(RENDERER_PORT)..."
	cd $(RENDERER_DIR) && \
		pip install -q -r requirements.txt && \
		uvicorn app:app --host 0.0.0.0 --port $(RENDERER_PORT) --reload

run-syslog: db-start ## Run the syslog receiver locally
	@echo "Starting Syslog receiver..."
	cd $(SYSLOG_DIR) && go run main.go

# ─── Code quality targets ─────────────────────────────────────────────────────

lint: ## Lint all services
	cd $(API_DIR) && go vet ./...
	cd $(SYSLOG_DIR) && go vet ./...
	cd $(UI_DIR) && npm run lint
	cd $(RENDERER_DIR) && python -m flake8 app.py

test: ## Run all tests
	cd $(API_DIR) && go test ./... -v
	cd $(SYSLOG_DIR) && go test ./... -v
	cd $(RENDERER_DIR) && python -m pytest tests/ -v

# ─── Cleanup ──────────────────────────────────────────────────────────────────

clean: ## Remove build artifacts
	rm -rf $(API_DIR)/bin
	rm -rf $(SYSLOG_DIR)/bin
	rm -rf $(UI_DIR)/dist
	rm -rf $(UI_DIR)/node_modules
	find . -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
