package handlers

import (
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type InventoryHandler struct {
	pool *pgxpool.Pool
}

func NewInventoryHandler(pool *pgxpool.Pool) *InventoryHandler {
	return &InventoryHandler{pool: pool}
}

type InventoryDevice struct {
	ID           string  `json:"id"`
	MAC          *string `json:"mac,omitempty"`
	Serial       *string `json:"serial,omitempty"`
	Hostname     *string `json:"hostname,omitempty"`
	Description  *string `json:"description,omitempty"`
	VendorClass  *string `json:"vendor_class,omitempty"`
	Status       string  `json:"status"`
	ManagementIP *string `json:"management_ip,omitempty"`
	ProfileName  *string `json:"profile_name,omitempty"`
	CustomerName *string `json:"customer_name,omitempty"`
}

// List GET /api/v1/inventory
// Returns all devices with their current management IP (from lease4) and profile info.
func (h *InventoryHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.pool.Query(r.Context(), `
		SELECT
			d.id,
			d.mac,
			d.serial,
			d.hostname,
			d.description,
			d.vendor_class,
			d.status,
			-- resolve management IP: match lease4 by MAC, then hostname, then serial
			COALESCE(
				(SELECT
					((l.address >> 24) & 255)::text || '.' ||
					((l.address >> 16) & 255)::text || '.' ||
					((l.address >> 8)  & 255)::text || '.' ||
					(l.address         & 255)::text
				 FROM lease4 l
				 WHERE d.mac IS NOT NULL
				   AND encode(l.hwaddr, 'hex') = REPLACE(d.mac::text, ':', '')
				 LIMIT 1),
				(SELECT
					((l.address >> 24) & 255)::text || '.' ||
					((l.address >> 16) & 255)::text || '.' ||
					((l.address >> 8)  & 255)::text || '.' ||
					(l.address         & 255)::text
				 FROM lease4 l
				 WHERE d.hostname IS NOT NULL AND l.hostname != ''
				   AND LOWER(l.hostname) = LOWER(d.hostname)
				 LIMIT 1),
				(SELECT
					((l.address >> 24) & 255)::text || '.' ||
					((l.address >> 16) & 255)::text || '.' ||
					((l.address >> 8)  & 255)::text || '.' ||
					(l.address         & 255)::text
				 FROM lease4 l
				 WHERE d.serial IS NOT NULL AND l.hostname != ''
				   AND LOWER(l.hostname) = LOWER(d.serial)
				 LIMIT 1)
			) AS management_ip,
			p.name AS profile_name,
			c.name AS customer_name
		FROM devices d
		LEFT JOIN device_profiles p ON p.id = d.profile_id
		LEFT JOIN customers c ON c.id = p.customer_id
		ORDER BY d.hostname NULLS LAST, d.mac
	`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "inventory query failed: "+err.Error())
		return
	}
	defer rows.Close()

	devices := []InventoryDevice{}
	for rows.Next() {
		var dev InventoryDevice
		var mac, serial, hostname, desc, vendorClass, mgmtIP, profileName, customerName *string
		if err := rows.Scan(
			&dev.ID, &mac, &serial, &hostname, &desc, &vendorClass,
			&dev.Status, &mgmtIP, &profileName, &customerName,
		); err != nil {
			continue
		}
		// Normalize MAC formatting (stored as XX:XX:XX:XX:XX:XX)
		if mac != nil {
			s := strings.ToLower(*mac)
			dev.MAC = &s
		}
		dev.Serial       = serial
		dev.Hostname     = hostname
		dev.Description  = desc
		dev.VendorClass  = vendorClass
		dev.ManagementIP = mgmtIP
		dev.ProfileName  = profileName
		dev.CustomerName = customerName

		devices = append(devices, dev)
	}
	writeJSON(w, http.StatusOK, devices)
}
