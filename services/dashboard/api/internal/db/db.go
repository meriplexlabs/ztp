// Package db provides PostgreSQL query helpers using pgx.
package db

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"github.com/ztp/api/internal/models"
)

// Connect creates a new pgxpool with retry logic.
func Connect(ctx context.Context, connStr string) (*pgxpool.Pool, error) {
	var pool *pgxpool.Pool
	var err error
	for i := range 10 {
		pool, err = pgxpool.New(ctx, connStr)
		if err == nil {
			if pingErr := pool.Ping(ctx); pingErr == nil {
				return pool, nil
			}
		}
		fmt.Printf("Waiting for database (attempt %d/10)...\n", i+1)
		time.Sleep(3 * time.Second)
	}
	return nil, fmt.Errorf("database unreachable after 10 attempts: %w", err)
}

// ─── Users ────────────────────────────────────────────────────────────────────

func GetUserByUsername(ctx context.Context, pool *pgxpool.Pool, username string) (*models.User, string, error) {
	var u models.User
	var passwordHash string
	err := pool.QueryRow(ctx,
		`SELECT id, username, email, password_hash, role, oidc_sub, active, created_at, updated_at
		 FROM users WHERE username = $1 AND active = TRUE`,
		username,
	).Scan(
		&u.ID, &u.Username, &u.Email, &passwordHash,
		&u.Role, &u.OIDCSub, &u.Active, &u.CreatedAt, &u.UpdatedAt,
	)
	if err != nil {
		return nil, "", err
	}
	return &u, passwordHash, nil
}

func GetOrCreateOIDCUser(ctx context.Context, pool *pgxpool.Pool, sub, email, username string) (*models.User, error) {
	var u models.User
	err := pool.QueryRow(ctx,
		`INSERT INTO users (username, email, oidc_sub, role)
		 VALUES ($1, $2, $3, 'viewer')
		 ON CONFLICT (oidc_sub) DO UPDATE
		   SET email = EXCLUDED.email, updated_at = NOW()
		 RETURNING id, username, email, role, active, created_at, updated_at`,
		username, email, sub,
	).Scan(&u.ID, &u.Username, &u.Email, &u.Role, &u.Active, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("upsert OIDC user: %w", err)
	}
	return &u, nil
}

func VerifyLocalPassword(hash, password string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

func ListUsers(ctx context.Context, pool *pgxpool.Pool) ([]models.User, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, username, email, role, active, created_at, updated_at
		 FROM users ORDER BY username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []models.User
	for rows.Next() {
		var u models.User
		if err := rows.Scan(&u.ID, &u.Username, &u.Email, &u.Role, &u.Active, &u.CreatedAt, &u.UpdatedAt); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, nil
}

// ─── Devices ──────────────────────────────────────────────────────────────────

func ListDevices(ctx context.Context, pool *pgxpool.Pool) ([]models.Device, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, mac, serial, vendor_class, hostname, description,
		        status, profile_id, variables, last_seen, provisioned_at,
		        firmware_version, firmware_checked_at, created_at, updated_at
		 FROM devices ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var devices []models.Device
	for rows.Next() {
		d, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		devices = append(devices, *d)
	}
	return devices, nil
}

func GetDevice(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) (*models.Device, error) {
	row := pool.QueryRow(ctx,
		`SELECT id, mac, serial, vendor_class, hostname, description,
		        status, profile_id, variables, last_seen, provisioned_at,
		        firmware_version, firmware_checked_at, created_at, updated_at
		 FROM devices WHERE id = $1`, id)
	return scanDevice(row)
}

func GetDeviceByIdentifier(ctx context.Context, pool *pgxpool.Pool, identifier string) (*models.Device, error) {
	// Try serial first — avoids macaddr cast errors for non-MAC identifiers.
	row := pool.QueryRow(ctx,
		`SELECT id, mac, serial, vendor_class, hostname, description,
		        status, profile_id, variables, last_seen, provisioned_at,
		        firmware_version, firmware_checked_at, created_at, updated_at
		 FROM devices WHERE serial = $1 LIMIT 1`, identifier)
	d, err := scanDevice(row)
	if err == nil {
		return d, nil
	}
	// Fall back to MAC lookup (only attempted when identifier looks like a MAC).
	row = pool.QueryRow(ctx,
		`SELECT id, mac, serial, vendor_class, hostname, description,
		        status, profile_id, variables, last_seen, provisioned_at,
		        firmware_version, firmware_checked_at, created_at, updated_at
		 FROM devices WHERE mac::text = lower($1) LIMIT 1`, identifier)
	return scanDevice(row)
}

type scannable interface {
	Scan(dest ...any) error
}

func scanDevice(row scannable) (*models.Device, error) {
	var d models.Device
	var variables []byte
	err := row.Scan(
		&d.ID, &d.MAC, &d.Serial, &d.VendorClass, &d.Hostname, &d.Description,
		&d.Status, &d.ProfileID, &variables, &d.LastSeen, &d.ProvisionedAt,
		&d.FirmwareVersion, &d.FirmwareCheckedAt, &d.CreatedAt, &d.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if len(variables) > 0 {
		_ = json.Unmarshal(variables, &d.Variables)
	}
	if d.Variables == nil {
		d.Variables = map[string]any{}
	}
	return &d, nil
}

func CreateDevice(ctx context.Context, pool *pgxpool.Pool, d *models.Device) error {
	vars, _ := json.Marshal(d.Variables)
	return pool.QueryRow(ctx,
		`INSERT INTO devices (mac, serial, vendor_class, hostname, description, profile_id, variables)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id, created_at, updated_at`,
		d.MAC, d.Serial, d.VendorClass, d.Hostname, d.Description, d.ProfileID, vars,
	).Scan(&d.ID, &d.CreatedAt, &d.UpdatedAt)
}

func UpdateDevice(ctx context.Context, pool *pgxpool.Pool, d *models.Device) error {
	vars, _ := json.Marshal(d.Variables)
	_, err := pool.Exec(ctx,
		`UPDATE devices SET
		    mac=$1, serial=$2, vendor_class=$3, hostname=$4,
		    description=$5, profile_id=$6, variables=$7, status=$8,
		    provisioned_at=$9
		 WHERE id=$10`,
		d.MAC, d.Serial, d.VendorClass, d.Hostname,
		d.Description, d.ProfileID, vars, d.Status,
		d.ProvisionedAt, d.ID,
	)
	return err
}

func DeleteDevice(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) error {
	_, err := pool.Exec(ctx, `DELETE FROM devices WHERE id = $1`, id)
	return err
}

func UpdateDeviceFirmware(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID, version string) error {
	_, err := pool.Exec(ctx,
		`UPDATE devices SET firmware_version=$1, firmware_checked_at=NOW() WHERE id=$2`,
		version, id)
	return err
}

// ─── Config Templates ─────────────────────────────────────────────────────────

func ListTemplates(ctx context.Context, pool *pgxpool.Pool) ([]models.ConfigTemplate, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, name, vendor, os_type, file_path, content, variables, created_by, created_at, updated_at
		 FROM config_templates ORDER BY vendor, os_type`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var templates []models.ConfigTemplate
	for rows.Next() {
		var t models.ConfigTemplate
		var variables []byte
		if err := rows.Scan(
			&t.ID, &t.Name, &t.Vendor, &t.OSType, &t.FilePath, &t.Content,
			&variables, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt,
		); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(variables, &t.Variables)
		templates = append(templates, t)
	}
	return templates, nil
}

func GetTemplate(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) (*models.ConfigTemplate, error) {
	var t models.ConfigTemplate
	var variables []byte
	err := pool.QueryRow(ctx,
		`SELECT id, name, vendor, os_type, file_path, content, variables, created_by, created_at, updated_at
		 FROM config_templates WHERE id = $1`, id,
	).Scan(&t.ID, &t.Name, &t.Vendor, &t.OSType, &t.FilePath, &t.Content,
		&variables, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(variables, &t.Variables)
	return &t, nil
}

// ─── Device Profiles ──────────────────────────────────────────────────────────

func GetProfile(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) (*models.DeviceProfile, error) {
	var p models.DeviceProfile
	var variables []byte
	err := pool.QueryRow(ctx,
		`SELECT id, name, description, customer_id, template_id, firmware_version, variables, created_by, created_at, updated_at
		 FROM device_profiles WHERE id = $1`, id,
	).Scan(&p.ID, &p.Name, &p.Description, &p.CustomerID, &p.TemplateID, &p.FirmwareVersion, &variables, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("profile not found: %w", err)
	}
	if len(variables) > 0 {
		_ = json.Unmarshal(variables, &p.Variables)
	}
	if p.Variables == nil {
		p.Variables = map[string]any{}
	}
	return &p, nil
}

// ─── Syslog Events ────────────────────────────────────────────────────────────

func ListEvents(ctx context.Context, pool *pgxpool.Pool, limit, offset int) ([]models.SyslogEvent, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, device_id, source_ip::text, severity, facility, hostname, app_name, message, received_at
		 FROM syslog_events
		 ORDER BY received_at DESC
		 LIMIT $1 OFFSET $2`, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []models.SyslogEvent
	for rows.Next() {
		var e models.SyslogEvent
		if err := rows.Scan(
			&e.ID, &e.DeviceID, &e.SourceIP, &e.Severity, &e.Facility,
			&e.Hostname, &e.AppName, &e.Message, &e.ReceivedAt,
		); err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	if events == nil {
		events = []models.SyslogEvent{}
	}
	return events, nil
}

// ─── Settings ─────────────────────────────────────────────────────────────────

type Setting struct {
	Key         string  `json:"key"`
	Value       *string `json:"value"` // nil = not set in DB, consumer should use env/default
	Label       string  `json:"label"`
	Description *string `json:"description,omitempty"`
	Category    string  `json:"category"`
}

func ListSettings(ctx context.Context, pool *pgxpool.Pool) ([]Setting, error) {
	rows, err := pool.Query(ctx,
		`SELECT key, value, label, description, category FROM settings ORDER BY category, key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Setting
	for rows.Next() {
		var s Setting
		if err := rows.Scan(&s.Key, &s.Value, &s.Label, &s.Description, &s.Category); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}

func SetSetting(ctx context.Context, pool *pgxpool.Pool, key, value string, userID uuid.UUID) error {
	_, err := pool.Exec(ctx,
		`UPDATE settings SET value = $1, updated_by = $2, updated_at = NOW() WHERE key = $3`,
		value, userID, key)
	return err
}

func ClearSetting(ctx context.Context, pool *pgxpool.Pool, key string) error {
	_, err := pool.Exec(ctx,
		`UPDATE settings SET value = NULL, updated_by = NULL, updated_at = NOW() WHERE key = $1`, key)
	return err
}

// ─── Password Change ──────────────────────────────────────────────────────────

func ChangePassword(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, newHash string) error {
	_, err := pool.Exec(ctx,
		`UPDATE users SET password_hash = $1 WHERE id = $2`, newHash, userID)
	return err
}

// ─── Customers ────────────────────────────────────────────────────────────────

func ListCustomers(ctx context.Context, pool *pgxpool.Pool) ([]models.Customer, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, name, description, created_at, updated_at FROM customers ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.Customer
	for rows.Next() {
		var c models.Customer
		if err := rows.Scan(&c.ID, &c.Name, &c.Description, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if out == nil {
		out = []models.Customer{}
	}
	return out, nil
}

func CreateCustomer(ctx context.Context, pool *pgxpool.Pool, c *models.Customer) error {
	return pool.QueryRow(ctx,
		`INSERT INTO customers (name, description) VALUES ($1, $2)
		 RETURNING id, created_at, updated_at`,
		c.Name, c.Description,
	).Scan(&c.ID, &c.CreatedAt, &c.UpdatedAt)
}

func UpdateCustomer(ctx context.Context, pool *pgxpool.Pool, c *models.Customer) error {
	_, err := pool.Exec(ctx,
		`UPDATE customers SET name=$1, description=$2, updated_at=NOW() WHERE id=$3`,
		c.Name, c.Description, c.ID)
	return err
}

func DeleteCustomer(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) error {
	_, err := pool.Exec(ctx, `DELETE FROM customers WHERE id=$1`, id)
	return err
}

// ─── Device Profiles (write) ──────────────────────────────────────────────────

func ListProfiles(ctx context.Context, pool *pgxpool.Pool) ([]models.DeviceProfile, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, name, description, customer_id, template_id, firmware_version, variables, created_by, created_at, updated_at
		 FROM device_profiles ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var profiles []models.DeviceProfile
	for rows.Next() {
		var p models.DeviceProfile
		var variables []byte
		if err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.CustomerID, &p.TemplateID, &p.FirmwareVersion, &variables, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		if len(variables) > 0 {
			_ = json.Unmarshal(variables, &p.Variables)
		}
		if p.Variables == nil {
			p.Variables = map[string]any{}
		}
		profiles = append(profiles, p)
	}
	return profiles, nil
}

func CreateProfile(ctx context.Context, pool *pgxpool.Pool, p *models.DeviceProfile) error {
	vars, _ := json.Marshal(p.Variables)
	return pool.QueryRow(ctx,
		`INSERT INTO device_profiles (name, description, customer_id, template_id, firmware_version, variables, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id, created_at, updated_at`,
		p.Name, p.Description, p.CustomerID, p.TemplateID, p.FirmwareVersion, vars, p.CreatedBy,
	).Scan(&p.ID, &p.CreatedAt, &p.UpdatedAt)
}

func UpdateProfile(ctx context.Context, pool *pgxpool.Pool, p *models.DeviceProfile) error {
	vars, _ := json.Marshal(p.Variables)
	_, err := pool.Exec(ctx,
		`UPDATE device_profiles SET name=$1, description=$2, customer_id=$3, template_id=$4, firmware_version=$5, variables=$6
		 WHERE id=$7`,
		p.Name, p.Description, p.CustomerID, p.TemplateID, p.FirmwareVersion, vars, p.ID,
	)
	return err
}

func DeleteProfile(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) error {
	_, err := pool.Exec(ctx, `DELETE FROM device_profiles WHERE id = $1`, id)
	return err
}

// ─── Config Templates (write) ─────────────────────────────────────────────────

func CreateTemplate(ctx context.Context, pool *pgxpool.Pool, t *models.ConfigTemplate) error {
	vars, _ := json.Marshal(t.Variables)
	return pool.QueryRow(ctx,
		`INSERT INTO config_templates (name, vendor, os_type, file_path, content, variables, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id, created_at, updated_at`,
		t.Name, t.Vendor, t.OSType, t.FilePath, t.Content, vars, t.CreatedBy,
	).Scan(&t.ID, &t.CreatedAt, &t.UpdatedAt)
}

func UpdateTemplate(ctx context.Context, pool *pgxpool.Pool, t *models.ConfigTemplate) error {
	vars, _ := json.Marshal(t.Variables)
	_, err := pool.Exec(ctx,
		`UPDATE config_templates SET name=$1, vendor=$2, os_type=$3, file_path=$4, content=$5, variables=$6
		 WHERE id=$7`,
		t.Name, t.Vendor, t.OSType, t.FilePath, t.Content, vars, t.ID,
	)
	return err
}

func DeleteTemplate(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID) error {
	_, err := pool.Exec(ctx, `DELETE FROM config_templates WHERE id = $1`, id)
	return err
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

type Alert struct {
	ID         int64      `json:"id"`
	Type       string     `json:"type"`
	Severity   string     `json:"severity"`
	DeviceID   *uuid.UUID `json:"device_id,omitempty"`
	Message    string     `json:"message"`
	Resolved   bool       `json:"resolved"`
	ResolvedAt *time.Time `json:"resolved_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}

func ListAlerts(ctx context.Context, pool *pgxpool.Pool, resolvedOnly bool) ([]Alert, error) {
	q := `SELECT id, type, severity, device_id, message, resolved, resolved_at, created_at
	      FROM alerts`
	if !resolvedOnly {
		q += ` WHERE resolved = FALSE`
	}
	q += ` ORDER BY created_at DESC LIMIT 200`
	rows, err := pool.Query(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Alert
	for rows.Next() {
		var a Alert
		if err := rows.Scan(&a.ID, &a.Type, &a.Severity, &a.DeviceID, &a.Message, &a.Resolved, &a.ResolvedAt, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	if out == nil {
		out = []Alert{}
	}
	return out, nil
}

func UpsertAlert(ctx context.Context, pool *pgxpool.Pool, alertType, severity string, deviceID *uuid.UUID, message string) error {
	_, err := pool.Exec(ctx,
		`INSERT INTO alerts (type, severity, device_id, message)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (type, device_id) DO UPDATE
		   SET message = EXCLUDED.message, resolved = FALSE, resolved_at = NULL`,
		alertType, severity, deviceID, message)
	return err
}

func ResolveAlertByTypeAndDevice(ctx context.Context, pool *pgxpool.Pool, alertType string, deviceID *uuid.UUID) error {
	_, err := pool.Exec(ctx,
		`UPDATE alerts SET resolved = TRUE, resolved_at = NOW()
		 WHERE type = $1 AND device_id = $2 AND resolved = FALSE`,
		alertType, deviceID)
	return err
}

func ResolveAlert(ctx context.Context, pool *pgxpool.Pool, id int64) error {
	_, err := pool.Exec(ctx,
		`UPDATE alerts SET resolved = TRUE, resolved_at = NOW() WHERE id = $1`, id)
	return err
}

func CountUnresolvedAlerts(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	var n int
	err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM alerts WHERE resolved = FALSE`).Scan(&n)
	return n, err
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

type AuditEntry struct {
	ID         int64      `json:"id"`
	UserID     *uuid.UUID `json:"user_id,omitempty"`
	Username   *string    `json:"username,omitempty"`
	Action     string     `json:"action"`
	EntityType *string    `json:"entity_type,omitempty"`
	EntityID   *uuid.UUID `json:"entity_id,omitempty"`
	Payload    []byte     `json:"payload"`
	IPAddress  *string    `json:"ip_address,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}

func ListAuditLog(ctx context.Context, pool *pgxpool.Pool, limit, offset int) ([]AuditEntry, error) {
	rows, err := pool.Query(ctx,
		`SELECT id, user_id, username, action, entity_type, entity_id,
		        payload, ip_address::text, created_at
		 FROM audit_log
		 ORDER BY created_at DESC
		 LIMIT $1 OFFSET $2`, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var entries []AuditEntry
	for rows.Next() {
		var e AuditEntry
		if err := rows.Scan(
			&e.ID, &e.UserID, &e.Username, &e.Action, &e.EntityType, &e.EntityID,
			&e.Payload, &e.IPAddress, &e.CreatedAt,
		); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	if entries == nil {
		entries = []AuditEntry{}
	}
	return entries, nil
}

func WriteAudit(ctx context.Context, pool *pgxpool.Pool,
	userID *uuid.UUID, username, action, entityType string, entityID *uuid.UUID,
	payload map[string]any, ipAddr string,
) {
	p, _ := json.Marshal(payload)
	_, err := pool.Exec(ctx,
		`INSERT INTO audit_log (user_id, username, action, entity_type, entity_id, payload, ip_address)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::inet)`,
		userID, username, action, entityType, entityID, p, ipAddr,
	)
	if err != nil {
		// Non-fatal: log but don't fail the request
		fmt.Printf("audit log write failed: %v\n", err)
	}
}
