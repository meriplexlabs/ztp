// Package gitops provides git-backed config backup and template sync.
package gitops

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	dbpkg "github.com/ztp/api/internal/db"
	"github.com/ztp/api/internal/models"
)

// CommitConfig backs up a device's running config to the configured git repo.
// Should be called in a goroutine — errors are logged, not returned.
func CommitConfig(ctx context.Context, pool *pgxpool.Pool, device *models.Device, configText string) {
	if dbpkg.GetSettingValue(ctx, pool, "git.backup_enabled") != "true" {
		return
	}
	repoURL := dbpkg.GetSettingValue(ctx, pool, "git.backup_repo_url")
	if repoURL == "" {
		return
	}
	branch := orDefault(dbpkg.GetSettingValue(ctx, pool, "git.backup_branch"), "main")
	token  := dbpkg.GetSettingValue(ctx, pool, "git.backup_token")
	name   := orDefault(dbpkg.GetSettingValue(ctx, pool, "git.backup_author_name"), "ZTP Server")
	email  := orDefault(dbpkg.GetSettingValue(ctx, pool, "git.backup_author_email"), "ztp@localhost")

	authURL := injectToken(repoURL, token)
	if authURL == "" {
		log.Warn().Str("url", repoURL).Msg("git backup: could not parse repo URL")
		return
	}

	ident := deviceIdent(device)

	dir, err := os.MkdirTemp("", "ztp-git-backup-*")
	if err != nil {
		log.Error().Err(err).Msg("git backup: mktemp failed")
		return
	}
	defer os.RemoveAll(dir)

	// Clone; fall back to init for brand-new repos / branches that don't exist yet
	if err := runGit(dir, "clone", "--depth=1", "--single-branch", "--branch", branch, authURL, "."); err != nil {
		log.Debug().Err(err).Msg("git backup: clone failed, initialising fresh repo")
		runGit(dir, "init")
		runGit(dir, "remote", "add", "origin", authURL)
		runGit(dir, "checkout", "-b", branch)
	}

	devDir := filepath.Join(dir, "devices", ident)
	if err := os.MkdirAll(devDir, 0o755); err != nil {
		log.Error().Err(err).Msg("git backup: mkdir failed")
		return
	}
	if err := os.WriteFile(filepath.Join(devDir, "config.cfg"), []byte(configText), 0o644); err != nil {
		log.Error().Err(err).Msg("git backup: write failed")
		return
	}

	runGit(dir, "config", "user.name", name)
	runGit(dir, "config", "user.email", email)
	runGit(dir, "add", "-A")

	msg := fmt.Sprintf("backup: %s config %s", ident, time.Now().UTC().Format(time.RFC3339))
	if err := runGit(dir, "commit", "-m", msg); err != nil {
		// "nothing to commit" — config unchanged, that's fine
		return
	}
	if err := runGit(dir, "push", "origin", branch); err != nil {
		log.Error().Err(err).Msg("git backup: push failed")
	}
}

// CommitProfile backs up a device profile as JSON to the configured git repo.
// Should be called in a goroutine — errors are logged, not returned.
func CommitProfile(ctx context.Context, pool *pgxpool.Pool, profile *models.DeviceProfile) {
	if dbpkg.GetSettingValue(ctx, pool, "git.backup_enabled") != "true" {
		return
	}
	repoURL := dbpkg.GetSettingValue(ctx, pool, "git.backup_repo_url")
	if repoURL == "" {
		return
	}
	branch := orDefault(dbpkg.GetSettingValue(ctx, pool, "git.backup_branch"), "main")
	token  := dbpkg.GetSettingValue(ctx, pool, "git.backup_token")
	name   := orDefault(dbpkg.GetSettingValue(ctx, pool, "git.backup_author_name"), "ZTP Server")
	email  := orDefault(dbpkg.GetSettingValue(ctx, pool, "git.backup_author_email"), "ztp@localhost")

	authURL := injectToken(repoURL, token)
	if authURL == "" {
		log.Warn().Str("url", repoURL).Msg("git backup: could not parse repo URL")
		return
	}

	dir, err := os.MkdirTemp("", "ztp-git-profile-*")
	if err != nil {
		log.Error().Err(err).Msg("git backup: mktemp failed")
		return
	}
	defer os.RemoveAll(dir)

	if err := runGit(dir, "clone", "--depth=1", "--single-branch", "--branch", branch, authURL, "."); err != nil {
		runGit(dir, "init")
		runGit(dir, "remote", "add", "origin", authURL)
		runGit(dir, "checkout", "-b", branch)
	}

	profDir := filepath.Join(dir, "profiles")
	if err := os.MkdirAll(profDir, 0o755); err != nil {
		log.Error().Err(err).Msg("git backup: mkdir failed")
		return
	}

	content, err := json.Marshal(profile)
	if err != nil {
		log.Error().Err(err).Msg("git backup: marshal profile failed")
		return
	}

	filename := sanitize(profile.Name) + ".json"
	if err := os.WriteFile(filepath.Join(profDir, filename), content, 0o644); err != nil {
		log.Error().Err(err).Msg("git backup: write failed")
		return
	}

	runGit(dir, "config", "user.name", name)
	runGit(dir, "config", "user.email", email)
	runGit(dir, "add", "-A")

	msg := fmt.Sprintf("backup: profile %s %s", profile.Name, time.Now().UTC().Format(time.RFC3339))
	if err := runGit(dir, "commit", "-m", msg); err != nil {
		return
	}
	if err := runGit(dir, "push", "origin", branch); err != nil {
		log.Error().Err(err).Msg("git backup: push failed")
	}
}

// SyncTemplates clones the template repo and upserts matching files into the DB.
// Returns the number of templates upserted.
func SyncTemplates(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	repoURL := dbpkg.GetSettingValue(ctx, pool, "git.template_repo_url")
	if repoURL == "" {
		return 0, fmt.Errorf("git.template_repo_url is not configured")
	}
	branch     := orDefault(dbpkg.GetSettingValue(ctx, pool, "git.template_branch"), "main")
	token      := dbpkg.GetSettingValue(ctx, pool, "git.template_token")
	pathPrefix := dbpkg.GetSettingValue(ctx, pool, "git.template_path")

	authURL := injectToken(repoURL, token)
	if authURL == "" {
		return 0, fmt.Errorf("could not parse git.template_repo_url")
	}

	dir, err := os.MkdirTemp("", "ztp-git-templates-*")
	if err != nil {
		return 0, err
	}
	defer os.RemoveAll(dir)

	if err := runGit(dir, "clone", "--depth=1", "--single-branch", "--branch", branch, authURL, "."); err != nil {
		return 0, fmt.Errorf("clone failed: %w", err)
	}

	scanDir := dir
	if pathPrefix != "" {
		scanDir = filepath.Join(dir, filepath.FromSlash(pathPrefix))
	}

	count := 0
	err = filepath.Walk(scanDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		ext := strings.ToLower(filepath.Ext(path))
		if ext != ".cfg" && ext != ".j2" {
			return nil
		}

		rel, _ := filepath.Rel(scanDir, path)
		slashRel := filepath.ToSlash(rel)
		parts := strings.SplitN(slashRel, "/", 3)
		if len(parts) < 2 {
			return nil // skip files at repo root
		}

		vendor := parts[0]
		var osType, tmplName string
		if len(parts) == 3 {
			// vendor/ostype/name.cfg
			osType   = parts[1]
			tmplName = strings.TrimSuffix(parts[2], filepath.Ext(parts[2]))
		} else {
			// vendor/name.cfg
			osType   = "generic"
			tmplName = strings.TrimSuffix(parts[1], filepath.Ext(parts[1]))
		}

		content, err := os.ReadFile(path)
		if err != nil {
			log.Warn().Err(err).Str("file", rel).Msg("git sync: read failed")
			return nil
		}

		if err := dbpkg.UpsertTemplate(ctx, pool, vendor, osType, tmplName, string(content)); err != nil {
			log.Warn().Err(err).Str("file", rel).Msg("git sync: upsert failed")
		} else {
			count++
		}
		return nil
	})

	return count, err
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func runGit(dir string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Debug().Err(err).Str("output", string(out)).Str("args", strings.Join(args, " ")).Msg("git command failed")
	}
	return err
}

// injectToken returns the repo URL with the token embedded as HTTPS credentials.
// Returns "" if repoURL is unparseable.
func injectToken(repoURL, token string) string {
	if token == "" {
		return repoURL
	}
	u, err := url.Parse(repoURL)
	if err != nil || u.Scheme == "" {
		return ""
	}
	u.User = url.UserPassword("oauth2", token)
	return u.String()
}

// deviceIdent returns a filesystem-safe identifier for the device.
func deviceIdent(device *models.Device) string {
	if device.Hostname != nil && *device.Hostname != "" {
		return sanitize(*device.Hostname)
	}
	if device.Serial != nil && *device.Serial != "" {
		return sanitize(*device.Serial)
	}
	if device.MAC != nil && *device.MAC != "" {
		return sanitize(*device.MAC)
	}
	return device.ID.String()
}

func sanitize(s string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			return r
		}
		return '-'
	}, s)
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
