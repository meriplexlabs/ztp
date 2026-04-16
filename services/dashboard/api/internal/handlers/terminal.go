package handlers

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"golang.org/x/crypto/ssh"

	"github.com/ztp/api/internal/auth"
	dbpkg "github.com/ztp/api/internal/db"
)

var wsUpgrader = websocket.Upgrader{
	HandshakeTimeout: 10 * time.Second,
	CheckOrigin:      func(r *http.Request) bool { return true },
}

// TerminalHandler provides a browser-accessible SSH terminal via WebSocket.
type TerminalHandler struct {
	pool      *pgxpool.Pool
	jwtSecret []byte
}

func NewTerminalHandler(pool *pgxpool.Pool, jwtSecret []byte) *TerminalHandler {
	return &TerminalHandler{pool: pool, jwtSecret: jwtSecret}
}

// ServeHTML serves the xterm.js terminal page (no auth required — the WebSocket checks it).
func (h *TerminalHandler) ServeHTML(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(terminalPageHTML))
}

// ServeWS bridges the browser WebSocket to an SSH session on the device.
// Auth: JWT accepted from ?token= query param (browsers can't set WS headers).
func (h *TerminalHandler) ServeWS(w http.ResponseWriter, r *http.Request) {
	// Accept token from query param (WebSocket) or Authorization header (API calls)
	token := r.URL.Query().Get("token")
	if token == "" {
		token = auth.ExtractBearerToken(r)
	}
	if token == "" {
		writeError(w, http.StatusUnauthorized, "missing token")
		return
	}
	if _, err := auth.VerifyJWT(h.jwtSecret, token); err != nil {
		writeError(w, http.StatusUnauthorized, "invalid or expired token")
		return
	}

	deviceID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid device ID")
		return
	}

	ctx := r.Context()
	device, err := dbpkg.GetDevice(ctx, h.pool, deviceID)
	if err != nil {
		writeError(w, http.StatusNotFound, "device not found")
		return
	}

	// Resolve management IP from the active Kea lease.
	// Try hostname first, then serial (for devices like Juniper identified by serial),
	// then MAC address as a final fallback.
	var mgmtIP string
	ipQuery := `
		SELECT
			((address >> 24) & 255)::text || '.' ||
			((address >> 16) & 255)::text || '.' ||
			((address >> 8)  & 255)::text || '.' ||
			(address         & 255)::text
		FROM lease4
		WHERE %s AND state = 0
		LIMIT 1
	`
	if device.Hostname != nil {
		row := h.pool.QueryRow(ctx, fmt.Sprintf(ipQuery, "LOWER(hostname) = LOWER($1)"), *device.Hostname)
		_ = row.Scan(&mgmtIP)
	}
	if mgmtIP == "" && device.Serial != nil {
		row := h.pool.QueryRow(ctx, fmt.Sprintf(ipQuery, "LOWER(hostname) = LOWER($1)"), *device.Serial)
		_ = row.Scan(&mgmtIP)
	}
	if mgmtIP == "" && device.MAC != nil {
		mac := strings.ReplaceAll(*device.MAC, ":", "")
		row := h.pool.QueryRow(ctx, fmt.Sprintf(ipQuery, "encode(hwaddr, 'hex') = $1"), mac)
		_ = row.Scan(&mgmtIP)
	}
	if mgmtIP == "" {
		writeError(w, http.StatusBadRequest, "no active DHCP lease — management IP unknown")
		return
	}

	// SSH credentials: merge profile vars (lower priority) under device vars
	merged := map[string]any{}
	if device.ProfileID != nil {
		if profile, err := dbpkg.GetProfile(ctx, h.pool, *device.ProfileID); err == nil {
			for k, v := range profile.Variables {
				merged[k] = v
			}
		}
	}
	for k, v := range device.Variables {
		merged[k] = v
	}

	username := "admin"
	if u, _ := merged["ssh_username"].(string); u != "" {
		username = u
	}
	password, _ := merged["local_password"].(string)
	if password == "" {
		writeError(w, http.StatusBadRequest, "local_password not set on device or profile")
		return
	}

	// Establish SSH connection before upgrading to WebSocket so errors can be HTTP responses
	sshCfg := &ssh.ClientConfig{
		User:            username,
		Auth:            []ssh.AuthMethod{ssh.Password(password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // internal ZTP network — acceptable
		Timeout:         15 * time.Second,
	}
	sshClient, err := ssh.Dial("tcp", net.JoinHostPort(mgmtIP, "22"), sshCfg)
	if err != nil {
		writeError(w, http.StatusBadGateway, "SSH connection failed: "+err.Error())
		return
	}
	defer sshClient.Close()

	session, err := sshClient.NewSession()
	if err != nil {
		writeError(w, http.StatusBadGateway, "SSH session failed: "+err.Error())
		return
	}
	defer session.Close()

	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 38400, ssh.TTY_OP_OSPEED: 38400}
	if err := session.RequestPty("xterm-256color", 40, 220, modes); err != nil {
		writeError(w, http.StatusBadGateway, "PTY request failed: "+err.Error())
		return
	}

	stdin, _ := session.StdinPipe()
	stdout, _ := session.StdoutPipe()

	if err := session.Shell(); err != nil {
		writeError(w, http.StatusBadGateway, "shell start failed: "+err.Error())
		return
	}

	// All SSH setup complete — now upgrade to WebSocket
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Error().Err(err).Msg("WebSocket upgrade failed")
		return
	}
	defer conn.Close()

	log.Info().
		Str("device", deviceID.String()).
		Str("ip", mgmtIP).
		Str("user", username).
		Msg("terminal session started")

	done := make(chan struct{})

	// SSH stdout → WebSocket (binary frames)
	go func() {
		defer close(done)
		buf := make([]byte, 4096)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				if e := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); e != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// WebSocket → SSH: binary = keystrokes, text = control JSON (resize)
	type resizeMsg struct {
		Type string `json:"type"`
		Cols uint32 `json:"cols"`
		Rows uint32 `json:"rows"`
	}
	for {
		mt, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if mt == websocket.TextMessage {
			var rm resizeMsg
			if json.Unmarshal(msg, &rm) == nil && rm.Type == "resize" && rm.Cols > 0 && rm.Rows > 0 {
				_ = session.WindowChange(int(rm.Rows), int(rm.Cols))
			}
			continue
		}
		if _, err := stdin.Write(msg); err != nil {
			break
		}
	}

	stdin.Close()
	<-done
	log.Info().Str("device", deviceID.String()).Msg("terminal session ended")
}

const terminalPageHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ZTP Terminal</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #1e1e1e; overflow: hidden; }
#t { width: 100vw; height: 100vh; }
</style>
</head>
<body>
<div id="t"></div>
<script>
const params  = new URLSearchParams(location.search);
const token   = params.get('token') || '';

const term = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: '"Cascadia Code","Fira Code","JetBrains Mono",monospace',
  theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#aeafad' }
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('t'));
fit.fit();

const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl  = proto + '//' + location.host + location.pathname + '/ws?token=' + encodeURIComponent(token);
const ws     = new WebSocket(wsUrl);
ws.binaryType = 'arraybuffer';

term.write('\x1b[90mConnecting...\x1b[0m');

ws.onopen = () => {
  term.clear();
  ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
};
ws.onmessage = e => {
  if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data));
};
ws.onclose  = () => term.write('\r\n\x1b[90m[Connection closed]\x1b[0m\r\n');
ws.onerror  = () => term.write('\r\n\x1b[31m[Connection error — check API logs]\x1b[0m\r\n');

term.onData(d => ws.readyState === 1 && ws.send(new TextEncoder().encode(d)));

function sendResize() {
  fit.fit();
  if (ws.readyState === 1)
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
}
window.addEventListener('resize', sendResize);
new ResizeObserver(sendResize).observe(document.getElementById('t'));
</script>
</body>
</html>`
