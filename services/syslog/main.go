// ZTP Syslog Receiver
// Listens on UDP and TCP for RFC 3164 / RFC 5424 syslog messages,
// persists them to PostgreSQL, and updates device status on known provisioning keywords.
package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

// ─── Config ───────────────────────────────────────────────────────────────────

type Config struct {
	UDPPort  string
	TCPPort  string
	DBConnStr string
}

func loadConfig() Config {
	return Config{
		UDPPort: getEnv("SYSLOG_UDP_PORT", "514"),
		TCPPort: getEnv("SYSLOG_TCP_PORT", "514"),
		DBConnStr: fmt.Sprintf(
			"host=%s port=%s dbname=%s user=%s password=%s sslmode=disable",
			getEnv("POSTGRES_HOST", "localhost"),
			getEnv("POSTGRES_PORT", "5432"),
			getEnv("POSTGRES_DB", "ztp"),
			getEnv("POSTGRES_USER", "ztp"),
			getEnv("POSTGRES_PASSWORD", "changeme"),
		),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ─── Syslog Message ───────────────────────────────────────────────────────────

type SyslogMessage struct {
	Facility  int
	Severity  int
	Hostname  string
	AppName   string
	ProcID    string
	MsgID     string
	Message   string
	Raw       string
	SourceIP  string
}

// rfc5424Pattern: <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID MSG
var rfc5424 = regexp.MustCompile(`^<(\d+)>(\d+) \S+ (\S+) (\S+) (\S+) (\S+) (.*)$`)

// rfc3164Pattern: <PRI>TIMESTAMP HOSTNAME TAG: MSG
var rfc3164 = regexp.MustCompile(`^<(\d+)>(\w{3}\s+\d+\s+\d+:\d+:\d+)\s+(\S+)\s+(\S+?):\s+(.*)$`)

func parse(raw string, sourceIP string) SyslogMessage {
	msg := SyslogMessage{Raw: raw, SourceIP: sourceIP}

	if m := rfc5424.FindStringSubmatch(raw); m != nil {
		pri, _ := strconv.Atoi(m[1])
		msg.Facility = pri >> 3
		msg.Severity = pri & 7
		msg.Hostname = nilDash(m[3])
		msg.AppName  = nilDash(m[4])
		msg.ProcID   = nilDash(m[5])
		msg.MsgID    = nilDash(m[6])
		msg.Message  = strings.TrimSpace(m[7])
		return msg
	}

	if m := rfc3164.FindStringSubmatch(raw); m != nil {
		pri, _ := strconv.Atoi(m[1])
		msg.Facility = pri >> 3
		msg.Severity = pri & 7
		msg.Hostname = m[3]
		msg.AppName  = strings.TrimSuffix(m[4], "[")
		msg.Message  = strings.TrimSpace(m[5])
		return msg
	}

	// Fallback: treat entire message as body
	msg.Severity = 6 // informational
	msg.Facility = 1 // user-level
	msg.Message  = raw
	return msg
}

func nilDash(s string) string {
	if s == "-" {
		return ""
	}
	return s
}

// ─── Provisioning Keywords ────────────────────────────────────────────────────
// These patterns in syslog messages trigger a device status update.

var provisionedKeywords = []string{
	"ZTP provisioned",
	"ztp-provision complete",
	"Autoinstall complete",
	"Auto-Install complete",
	"configuration applied",
}

func isProvisioningComplete(msg string) bool {
	lower := strings.ToLower(msg)
	for _, kw := range provisionedKeywords {
		if strings.Contains(lower, strings.ToLower(kw)) {
			return true
		}
	}
	return false
}

// ─── DB ───────────────────────────────────────────────────────────────────────

func insertEvent(ctx context.Context, pool *pgxpool.Pool, msg SyslogMessage) {
	_, err := pool.Exec(ctx,
		`INSERT INTO syslog_events
		 (source_ip, device_id, severity, facility, hostname, app_name, proc_id, msg_id, message, raw)
		 VALUES ($1,
		   (SELECT id FROM devices WHERE management_ip = $1::inet
		    UNION
		    SELECT device_id FROM dhcp_reservations WHERE ip_address = $1::inet
		    LIMIT 1),
		   $2, $3, $4, $5, $6, $7, $8, $9)`,
		msg.SourceIP, msg.Severity, msg.Facility,
		nullStr(msg.Hostname), nullStr(msg.AppName), nullStr(msg.ProcID),
		nullStr(msg.MsgID), msg.Message, msg.Raw,
	)
	if err != nil {
		log.Error().Err(err).Str("source", msg.SourceIP).Msg("Failed to insert syslog event")
	}
}

func updateDeviceLastSeen(ctx context.Context, pool *pgxpool.Pool, sourceIP string) {
	pool.Exec(ctx,
		`UPDATE devices SET last_seen = NOW()
		 WHERE management_ip = $1::inet
		    OR id = (SELECT device_id FROM dhcp_reservations WHERE ip_address = $1::inet LIMIT 1)`,
		sourceIP,
	)
}

func updateDeviceProvisioned(ctx context.Context, pool *pgxpool.Pool, sourceIP string) {
	res, err := pool.Exec(ctx,
		`UPDATE devices SET status = 'provisioned', provisioned_at = NOW()
		 WHERE id = (
		     SELECT d.id FROM devices d
		     JOIN dhcp_reservations r ON r.device_id = d.id
		     WHERE r.ip_address = $1::inet
		     LIMIT 1
		 ) AND status != 'provisioned'`,
		sourceIP,
	)
	if err != nil {
		log.Error().Err(err).Str("ip", sourceIP).Msg("Failed to update device status")
		return
	}
	if res.RowsAffected() > 0 {
		log.Info().Str("ip", sourceIP).Msg("Device marked as provisioned")
	}
}

func nullStr(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

// ─── Server ───────────────────────────────────────────────────────────────────

func handleMessage(ctx context.Context, pool *pgxpool.Pool, data []byte, sourceIP string) {
	raw := strings.TrimRight(string(data), "\r\n\x00")
	if raw == "" {
		return
	}
	msg := parse(raw, sourceIP)
	log.Debug().
		Str("src", sourceIP).
		Int("severity", msg.Severity).
		Str("message", msg.Message).
		Msg("syslog")

	insertEvent(ctx, pool, msg)
	updateDeviceLastSeen(ctx, pool, sourceIP)

	if isProvisioningComplete(msg.Message) {
		updateDeviceProvisioned(ctx, pool, sourceIP)
	}
}

func runUDP(ctx context.Context, pool *pgxpool.Pool, addr string) {
	conn, err := net.ListenPacket("udp", addr)
	if err != nil {
		log.Fatal().Err(err).Str("addr", addr).Msg("UDP listen failed")
	}
	defer conn.Close()
	log.Info().Str("addr", addr).Msg("UDP syslog listener started")

	buf := make([]byte, 65536)
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		conn.SetDeadline(time.Now().Add(time.Second))
		n, remote, err := conn.ReadFrom(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			log.Error().Err(err).Msg("UDP read error")
			continue
		}
		ip, _, _ := net.SplitHostPort(remote.String())
		handleMessage(ctx, pool, buf[:n], ip)
	}
}

func runTCP(ctx context.Context, pool *pgxpool.Pool, addr string) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatal().Err(err).Str("addr", addr).Msg("TCP listen failed")
	}
	defer ln.Close()
	log.Info().Str("addr", addr).Msg("TCP syslog listener started")

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		ln.(*net.TCPListener).SetDeadline(time.Now().Add(time.Second))
		conn, err := ln.Accept()
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			log.Error().Err(err).Msg("TCP accept error")
			continue
		}
		go func(c net.Conn) {
			defer c.Close()
			ip, _, _ := net.SplitHostPort(c.RemoteAddr().String())
			buf := make([]byte, 65536)
			c.SetDeadline(time.Now().Add(30 * time.Second))
			n, err := c.Read(buf)
			if err != nil {
				return
			}
			handleMessage(ctx, pool, buf[:n], ip)
		}(conn)
	}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

func main() {
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stdout, TimeFormat: time.RFC3339})

	cfg := loadConfig()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Connect to DB with retry
	var pool *pgxpool.Pool
	var err error
	for i := range 10 {
		pool, err = pgxpool.New(ctx, cfg.DBConnStr)
		if err == nil {
			if pingErr := pool.Ping(ctx); pingErr == nil {
				break
			}
		}
		log.Info().Int("attempt", i+1).Msg("Waiting for database...")
		time.Sleep(3 * time.Second)
	}
	if err != nil {
		log.Fatal().Err(err).Msg("Could not connect to database")
	}
	defer pool.Close()
	log.Info().Msg("Connected to database")

	udpAddr := "0.0.0.0:" + cfg.UDPPort
	tcpAddr := "0.0.0.0:" + cfg.TCPPort

	go runUDP(ctx, pool, udpAddr)
	go runTCP(ctx, pool, tcpAddr)

	<-ctx.Done()
	log.Info().Msg("Syslog receiver shutting down")
}
