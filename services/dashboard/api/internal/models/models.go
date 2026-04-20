package models

import (
	"time"

	"github.com/google/uuid"
)

// ─── User ─────────────────────────────────────────────────────────────────────

type UserRole string

const (
	RoleAdmin  UserRole = "admin"
	RoleEditor UserRole = "editor"
	RoleViewer UserRole = "viewer"
)

type User struct {
	ID           uuid.UUID  `json:"id"`
	Username     string     `json:"username"`
	Email        *string    `json:"email,omitempty"`
	Role         UserRole   `json:"role"`
	OIDCSub      *string    `json:"-"`
	Active       bool       `json:"active"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

// ─── Device ───────────────────────────────────────────────────────────────────

type DeviceStatus string

const (
	StatusUnknown      DeviceStatus = "unknown"
	StatusDiscovered   DeviceStatus = "discovered"
	StatusProvisioning DeviceStatus = "provisioning"
	StatusProvisioned  DeviceStatus = "provisioned"
	StatusFailed       DeviceStatus = "failed"
	StatusIgnored      DeviceStatus = "ignored"
)

type Device struct {
	ID            uuid.UUID    `json:"id"`
	MAC           *string      `json:"mac,omitempty"`
	Serial        *string      `json:"serial,omitempty"`
	VendorClass   *string      `json:"vendor_class,omitempty"`
	Hostname      *string      `json:"hostname,omitempty"`
	Description   *string      `json:"description,omitempty"`
	Status        DeviceStatus `json:"status"`
	ProfileID     *uuid.UUID   `json:"profile_id,omitempty"`
	Variables     map[string]any `json:"variables"`
	LastSeen          *time.Time `json:"last_seen,omitempty"`
	ProvisionedAt     *time.Time `json:"provisioned_at,omitempty"`
	FirmwareVersion   *string    `json:"firmware_version,omitempty"`
	FirmwareCheckedAt *time.Time `json:"firmware_checked_at,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

// ─── Config Template ──────────────────────────────────────────────────────────

type ConfigTemplate struct {
	ID        uuid.UUID      `json:"id"`
	Name      string         `json:"name"`
	Vendor    string         `json:"vendor"`
	OSType    string         `json:"os_type"`
	FilePath  *string        `json:"file_path,omitempty"`
	Content   *string        `json:"content,omitempty"`
	Variables []TemplateVar  `json:"variables"`
	CreatedBy *uuid.UUID     `json:"created_by,omitempty"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
}

type TemplateVar struct {
	Name        string  `json:"name"`
	Description string  `json:"description,omitempty"`
	Required    bool    `json:"required"`
	Default     *string `json:"default,omitempty"`
}

// ─── Customer ─────────────────────────────────────────────────────────────────

type Customer struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Description *string   `json:"description,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// ─── Device Profile ───────────────────────────────────────────────────────────

type DeviceProfile struct {
	ID              uuid.UUID      `json:"id"`
	Name            string         `json:"name"`
	Description     *string        `json:"description,omitempty"`
	CustomerID      *uuid.UUID     `json:"customer_id,omitempty"`
	TemplateID      *uuid.UUID     `json:"template_id,omitempty"`
	FirmwareVersion *string        `json:"firmware_version,omitempty"`
	Variables       map[string]any `json:"variables"`
	CreatedBy       *uuid.UUID     `json:"created_by,omitempty"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
}

// ─── DHCP Reservation ─────────────────────────────────────────────────────────

type DHCPReservation struct {
	ID        uuid.UUID      `json:"id"`
	DeviceID  *uuid.UUID     `json:"device_id,omitempty"`
	MAC       string         `json:"mac"`
	IPAddress string         `json:"ip_address"`
	Hostname  *string        `json:"hostname,omitempty"`
	Options   map[string]any `json:"options"`
	Active    bool           `json:"active"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
}

// ─── Syslog Event ─────────────────────────────────────────────────────────────

type SyslogEvent struct {
	ID         int64      `json:"id"`
	DeviceID   *uuid.UUID `json:"device_id,omitempty"`
	SourceIP   string     `json:"source_ip"`
	Severity   int        `json:"severity"`
	Facility   int        `json:"facility"`
	Hostname   *string    `json:"hostname,omitempty"`
	AppName    *string    `json:"app_name,omitempty"`
	Message    string     `json:"message"`
	ReceivedAt time.Time  `json:"received_at"`
}

// ─── JWT Claims ───────────────────────────────────────────────────────────────

type Claims struct {
	UserID   string   `json:"uid"`
	Username string   `json:"sub"`
	Role     UserRole `json:"role"`
	Email    string   `json:"email,omitempty"`
}
