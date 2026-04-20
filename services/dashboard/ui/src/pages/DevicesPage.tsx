import { useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { api, type Device, type DeviceProfile, type DHCPLease } from '@/lib/api'
import { formatRelative } from '@/lib/utils'
import { Server, RefreshCw, X, Plus, Trash2, Terminal, Download, GitCompare, Cpu, CheckCircle, XCircle } from 'lucide-react'
import { diffLines } from 'diff'

const STATUS_COLORS: Record<Device['status'], string> = {
  unknown:      'bg-gray-100 text-gray-700',
  discovered:   'bg-blue-100 text-blue-700',
  provisioning: 'bg-yellow-100 text-yellow-700',
  provisioned:  'bg-green-100 text-green-700',
  failed:       'bg-red-100 text-red-700',
  ignored:      'bg-gray-100 text-gray-500',
}

const STATUS_LABELS: Record<Device['status'], string> = {
  unknown:      'Unknown',
  discovered:   'Discovered',
  provisioning: 'Provisioning',
  provisioned:  'Provisioned',
  failed:       'Failed',
  ignored:      'Ignored',
}

const VENDOR_DISPLAY: Record<string, string> = {
  cisco:    'Cisco',
  juniper:  'Juniper',
  aruba:    'Aruba / HP',
  extreme:  'Extreme',
  fortinet: 'Fortinet',
}

const ZTP_METHOD: Record<string, string> = {
  cisco:    'Cisco PnP',
  juniper:  'HTTP',
  aruba:    'TFTP',
  extreme:  'TFTP',
  fortinet: 'TFTP',
}

function terminalUrl(deviceId: string) {
  const token = localStorage.getItem('ztp_token') ?? ''
  const base  = import.meta.env.VITE_API_URL ?? ''
  return `${base}/api/v1/devices/${deviceId}/terminal?token=${encodeURIComponent(token)}`
}

async function fetchTextEndpoint(path: string): Promise<string> {
  const token = localStorage.getItem('ztp_token') ?? ''
  const base  = import.meta.env.VITE_API_URL ?? ''
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }
  return res.text()
}

async function downloadConfig(deviceId: string, filename: string) {
  const text = await fetchTextEndpoint(`/api/v1/devices/${deviceId}/config`)
  triggerDownload(text, `${filename}-deployed.cfg`)
}

async function downloadRunningConfig(deviceId: string, filename: string) {
  const text = await fetchTextEndpoint(`/api/v1/devices/${deviceId}/running-config`)
  triggerDownload(text, `${filename}-running.cfg`)
}

function triggerDownload(text: string, filename: string) {
  const blob = new Blob([text], { type: 'text/plain' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const CONTEXT_LINES = 3

function DiffModal({ device, onClose }: { device: Device; onClose: () => void }) {
  const [deployed, setDeployed] = useState<string | null>(null)
  const [running,  setRunning]  = useState<string | null>(null)
  const [error,    setError]    = useState<string | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [pushing,  setPushing]  = useState(false)
  const [pushResult, setPushResult] = useState<{ success: boolean; output: string } | null>(null)
  const [confirmPush, setConfirmPush] = useState(false)

  useState(() => {
    let cancelled = false
    async function load() {
      try {
        const [d, r] = await Promise.all([
          fetchTextEndpoint(`/api/v1/devices/${device.id}/config`),
          fetchTextEndpoint(`/api/v1/devices/${device.id}/running-config`),
        ])
        if (!cancelled) { setDeployed(d); setRunning(r) }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load configs')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  })

  function normalize(text: string) {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map(l => l.trimEnd())
      .join('\n')
  }

  const hunks = (() => {
    if (!deployed || !running) return []
    const changes = diffLines(normalize(deployed), normalize(running))
    const result: { type: 'context' | 'added' | 'removed'; lines: string[] }[] = []
    let contextBuf: string[] = []

    function flushContext(take: number) {
      if (contextBuf.length > 0) {
        result.push({ type: 'context', lines: contextBuf.slice(-take) })
        contextBuf = []
      }
    }

    for (const change of changes) {
      const lines = change.value.replace(/\n$/, '').split('\n')
      if (!change.added && !change.removed) {
        // flush trailing context from previous hunk, buffer for next
        if (result.length > 0) {
          result.push({ type: 'context', lines: lines.slice(0, CONTEXT_LINES) })
        }
        contextBuf = lines
      } else {
        flushContext(CONTEXT_LINES)
        result.push({ type: change.added ? 'added' : 'removed', lines })
      }
    }
    return result
  })()

  const added   = hunks.filter(h => h.type === 'added').reduce((n, h) => n + h.lines.length, 0)
  const removed = hunks.filter(h => h.type === 'removed').reduce((n, h) => n + h.lines.length, 0)
  const clean   = deployed && running && added === 0 && removed === 0

  async function handlePush() {
    setPushing(true)
    setConfirmPush(false)
    try {
      const result = await api.post<{ success: boolean; output: string }>(
        `/api/v1/devices/${device.id}/push-config`, {}
      )
      setPushResult(result)
    } catch (e: unknown) {
      setPushResult({ success: false, output: e instanceof Error ? e.message : 'Push failed' })
    } finally {
      setPushing(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-[2px]">
      <div className="w-[80vw] max-w-5xl max-h-[85vh] flex flex-col bg-background border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
          <div className="flex items-center gap-3">
            <GitCompare className="h-4 w-4 text-muted-foreground" />
            <span className="font-semibold text-sm">
              {device.hostname ?? device.serial ?? device.id}
            </span>
            <span className="text-xs text-muted-foreground">deployed → running</span>
            {!loading && !error && (
              clean
                ? <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">No drift</span>
                : <span className="text-xs text-muted-foreground">
                    {removed > 0 && <span className="text-red-600 font-mono">−{removed} </span>}
                    {added   > 0 && <span className="text-green-600 font-mono">+{added}</span>}
                  </span>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Push result */}
        {pushResult && (
          <div className={`px-5 py-3 border-b text-xs font-mono shrink-0 max-h-40 overflow-auto ${pushResult.success ? 'bg-green-950/40 text-green-300' : 'bg-red-950/40 text-red-300'}`}>
            <p className="font-semibold mb-1">{pushResult.success ? '✓ Push successful' : '✗ Push failed'}</p>
            <pre className="whitespace-pre-wrap">{pushResult.output}</pre>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-auto bg-[#1e1e2e] font-mono text-xs leading-5">
          {loading && (
            <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
              Loading configs…
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-40 text-destructive text-sm px-6 text-center">
              {error}
            </div>
          )}
          {clean && (
            <div className="flex items-center justify-center h-40 text-green-400 text-sm">
              Deployed and running configs are identical.
            </div>
          )}
          {!loading && !error && !clean && hunks.map((hunk, hi) => (
            <div key={hi}>
              {hunk.type === 'context' && hunk.lines.map((line, li) => (
                <div key={li} className="flex px-4 py-px text-[#6c7086] select-text">
                  <span className="w-4 mr-4 text-[#45475a] select-none"> </span>
                  <span className="whitespace-pre">{line}</span>
                </div>
              ))}
              {hunk.type === 'removed' && hunk.lines.map((line, li) => (
                <div key={li} className="flex px-4 py-px bg-red-950/40 select-text">
                  <span className="w-4 mr-4 text-red-500 select-none">−</span>
                  <span className="whitespace-pre text-red-300">{line}</span>
                </div>
              ))}
              {hunk.type === 'added' && hunk.lines.map((line, li) => (
                <div key={li} className="flex px-4 py-px bg-green-950/40 select-text">
                  <span className="w-4 mr-4 text-green-500 select-none">+</span>
                  <span className="whitespace-pre text-green-300">{line}</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Footer — push action */}
        {!loading && !error && !clean && !pushResult && (
          <div className="border-t px-5 py-3 shrink-0 flex items-center justify-between bg-background">
            {confirmPush ? (
              <>
                <span className="text-xs text-muted-foreground">This will replace the running config. Are you sure?</span>
                <div className="flex gap-2">
                  <button onClick={() => setConfirmPush(false)}
                    className="text-sm px-3 py-1.5 rounded border hover:bg-accent">Cancel</button>
                  <button onClick={handlePush} disabled={pushing}
                    className="text-sm px-4 py-1.5 rounded bg-destructive text-destructive-foreground hover:opacity-90 disabled:opacity-50">
                    {pushing ? 'Pushing…' : 'Confirm Push'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="text-xs text-muted-foreground">
                  {removed > 0 && <span className="text-red-500 font-mono">−{removed} </span>}
                  {added   > 0 && <span className="text-green-500 font-mono">+{added} </span>}
                  lines differ from rendered config
                </span>
                <button onClick={() => setConfirmPush(true)}
                  className="flex items-center gap-1.5 text-sm px-4 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90">
                  <GitCompare className="h-4 w-4" /> Apply Rendered Config
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function TerminalOverlay({ device, onClose }: { device: Device; onClose: () => void }) {
  const [minimized, setMinimized] = useState(false)

  if (minimized) {
    return (
      <div
        className="fixed bottom-4 right-4 z-[100] bg-gray-900 border border-gray-700 rounded-lg shadow-2xl flex items-center gap-3 px-4 py-2 cursor-pointer hover:bg-gray-800"
        onClick={() => setMinimized(false)}
      >
        <Terminal className="h-4 w-4 text-green-400 shrink-0" />
        <span className="text-white text-sm font-mono">{device.hostname ?? device.serial}</span>
        <button
          onClick={e => { e.stopPropagation(); onClose() }}
          className="text-gray-500 hover:text-white ml-2"
        >✕</button>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-[2px]">
      <div className="w-[72vw] max-w-5xl h-[65vh] flex flex-col bg-black rounded-xl shadow-2xl overflow-hidden border border-gray-700 ring-1 ring-white/10">
        <div className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-700 shrink-0">
          <span className="text-white text-sm font-mono flex items-center gap-2">
            <Terminal className="h-4 w-4 text-green-400" />
            {device.hostname ?? device.serial ?? device.id}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMinimized(true)}
              className="text-gray-400 hover:text-white px-2 py-0.5 rounded hover:bg-gray-700 text-sm"
              title="Minimize"
            >─</button>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white px-2 py-0.5 rounded hover:bg-gray-700 text-sm"
              title="Close"
            >✕</button>
          </div>
        </div>
        <iframe
          src={terminalUrl(device.id)}
          className="flex-1 w-full border-0"
          title="Device terminal"
        />
      </div>
    </div>
  )
}

function DeviceDrawer({
  device,
  profiles,
  leases,
  onClose,
  onTerminal,
  onDiff,
}: {
  device: Device
  profiles: DeviceProfile[]
  leases: DHCPLease[]
  onClose: () => void
  onTerminal: (d: Device) => void
  onDiff: (d: Device) => void
}) {
  const qc = useQueryClient()
  const [hostname,    setHostname]    = useState(device.hostname ?? '')
  const [description, setDescription] = useState(device.description ?? '')
  const [profileId,   setProfileId]   = useState(device.profile_id ?? '')
  const [vars, setVars] = useState<[string, string][]>(
    Object.entries(device.variables ?? {}).map(([k, v]) => [k, String(v)])
  )
  const [firmwareVersion,   setFirmwareVersion]   = useState(device.firmware_version ?? null)
  const [firmwareCheckedAt, setFirmwareCheckedAt] = useState(device.firmware_checked_at ?? null)
  const [refreshingFirmware, setRefreshingFirmware] = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [downloading,        setDownloading]        = useState(false)
  const [downloadingRunning, setDownloadingRunning] = useState(false)

  const lease = leases.find(l =>
    (device.hostname && l.hostname === device.hostname) ||
    (device.mac && l.hw_address === device.mac)
  )

  const save = useMutation({
    mutationFn: (body: Partial<Device>) =>
      api.put<Device>(`/api/v1/devices/${device.id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] })
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  const del = useMutation({
    mutationFn: () => api.delete(`/api/v1/devices/${device.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] })
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  function handleSave() {
    setError(null)
    const variables = Object.fromEntries(vars.filter(([k]) => k.trim() !== ''))
    save.mutate({
      ...device,
      hostname:    hostname    || undefined,
      description: description || undefined,
      profile_id:  profileId  || undefined,
      variables,
    })
  }

  async function handleDownload() {
    setDownloading(true)
    setError(null)
    try {
      const name = device.hostname ?? device.serial ?? device.id
      await downloadConfig(device.id, name)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Download failed')
    } finally {
      setDownloading(false)
    }
  }

  async function handleRefreshFirmware() {
    setRefreshingFirmware(true)
    setError(null)
    try {
      const res = await api.post<{ firmware_version: string }>(`/api/v1/devices/${device.id}/firmware-version`, {})
      setFirmwareVersion(res.firmware_version)
      setFirmwareCheckedAt(new Date().toISOString())
      qc.invalidateQueries({ queryKey: ['devices'] })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Firmware check failed')
    } finally {
      setRefreshingFirmware(false)
    }
  }

  async function handleDownloadRunning() {
    setDownloadingRunning(true)
    setError(null)
    try {
      const name = device.hostname ?? device.serial ?? device.id
      await downloadRunningConfig(device.id, name)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to pull running config')
    } finally {
      setDownloadingRunning(false)
    }
  }

  function addVar()              { setVars(v => [...v, ['', '']]) }
  function removeVar(i: number)  { setVars(v => v.filter((_, j) => j !== i)) }
  function setVarKey(i: number, k: string) {
    setVars(v => v.map((pair, j) => j === i ? [k, pair[1]] : pair))
  }
  function setVarVal(i: number, val: string) {
    setVars(v => v.map((pair, j) => j === i ? [pair[0], val] : pair))
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      <div className="fixed right-0 top-0 h-full w-[440px] bg-background border-l shadow-xl z-50 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <p className="font-semibold text-sm">{device.hostname ?? device.serial ?? device.mac ?? device.id}</p>
            {device.description && (
              <p className="text-xs text-muted-foreground">{device.description}</p>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Read-only info */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Serial</p>
              <p className="font-mono text-xs">{device.serial ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">MAC</p>
              <p className="font-mono text-xs">{device.mac ?? lease?.hw_address ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Management IP</p>
              <p className="font-mono text-xs font-medium text-primary">{lease?.ip_address ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Status</p>
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[device.status]}`}>
                {STATUS_LABELS[device.status]}
              </span>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Vendor</p>
              <p className="text-xs">{device.vendor_class ? (VENDOR_DISPLAY[device.vendor_class] ?? device.vendor_class) : '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">ZTP Method</p>
              <p className="text-xs">{device.vendor_class ? (ZTP_METHOD[device.vendor_class] ?? '—') : '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Last Seen</p>
              <p className="text-xs">{device.last_seen ? formatRelative(device.last_seen) : '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Provisioned</p>
              <p className="text-xs">{device.provisioned_at ? formatRelative(device.provisioned_at) : '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Firmware Version</p>
              <div className="flex items-center gap-1.5">
                <Cpu className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="text-xs font-mono">{firmwareVersion ?? '—'}</span>
              </div>
              {firmwareCheckedAt && (
                <p className="text-xs text-muted-foreground mt-0.5">checked {formatRelative(firmwareCheckedAt)}</p>
              )}
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1"> </p>
              <button
                onClick={handleRefreshFirmware}
                disabled={refreshingFirmware || !lease?.ip_address}
                title={lease?.ip_address ? 'Refresh firmware version via SSH' : 'No management IP available'}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                <RefreshCw className={`h-3 w-3 ${refreshingFirmware ? 'animate-spin' : ''}`} />
                {refreshingFirmware ? 'Checking…' : 'Refresh'}
              </button>
            </div>
            {device.profile_id && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Deployed Config</p>
                <button
                  onClick={handleDownload}
                  disabled={downloading}
                  className="text-xs text-primary hover:underline disabled:opacity-50 flex items-center gap-1"
                >
                  <Download className="h-3 w-3" />
                  {downloading ? 'Downloading…' : 'Download'}
                </button>
              </div>
            )}
            <div>
              <p className="text-xs text-muted-foreground mb-1">Running Config</p>
              <button
                onClick={handleDownloadRunning}
                disabled={downloadingRunning}
                className="text-xs text-primary hover:underline disabled:opacity-50 flex items-center gap-1"
              >
                <Download className="h-3 w-3" />
                {downloadingRunning ? 'Pulling…' : 'Download'}
              </button>
            </div>
            {device.profile_id && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Config Diff</p>
                <button
                  onClick={() => { onClose(); onDiff(device) }}
                  className="text-xs text-primary hover:underline flex items-center gap-1"
                >
                  <GitCompare className="h-3 w-3" />
                  View diff
                </button>
              </div>
            )}
          </div>

          {/* Hostname */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Hostname</label>
            <input
              type="text"
              value={hostname}
              onChange={e => setHostname(e.target.value)}
              placeholder="e.g. sw-core-01"
              className="w-full text-sm border rounded px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* Model / Description */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Model / Description</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="e.g. EX2300-24P"
              className="w-full text-sm border rounded px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* Profile */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Profile</label>
            <select
              value={profileId}
              onChange={e => setProfileId(e.target.value)}
              className="w-full text-sm border rounded px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="">— No profile —</option>
              {profiles.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Variables */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-muted-foreground">Variables</label>
              <button
                onClick={addVar}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
            <div className="space-y-2">
              {vars.map(([k, v], i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={k}
                    onChange={e => setVarKey(i, e.target.value)}
                    placeholder="key"
                    className="flex-1 text-xs border rounded px-2 py-1.5 bg-background font-mono focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                  <input
                    type="text"
                    value={v}
                    onChange={e => setVarVal(i, e.target.value)}
                    placeholder="value"
                    className="flex-1 text-xs border rounded px-2 py-1.5 bg-background font-mono focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                  <button onClick={() => removeVar(i)} className="text-muted-foreground hover:text-destructive">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {vars.length === 0 && (
                <p className="text-xs text-muted-foreground">No variables set</p>
              )}
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        {/* Footer */}
        <div className="border-t px-5 py-3 flex items-center justify-between shrink-0">
          <button
            onClick={() => { if (confirm('Delete this device?')) del.mutate() }}
            disabled={del.isPending}
            title="Delete device"
            className="p-1.5 text-destructive hover:opacity-80 disabled:opacity-50 rounded hover:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2">
            {lease?.ip_address && (
              <button
                onClick={() => { onClose(); onTerminal(device) }}
                title="Open terminal"
                className="p-1.5 rounded border border-green-600 text-green-700 hover:bg-green-50"
              >
                <Terminal className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={save.isPending}
              className="text-sm px-4 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Bulk action types ────────────────────────────────────────────────────────

type BulkOp = { id: string; status: 'pending' | 'ok' | 'error'; message?: string }

function BulkActionBar({
  selected, devices, profiles, onClear, onRefresh,
}: {
  selected: Set<string>
  devices: Device[]
  profiles: DeviceProfile[]
  onClear: () => void
  onRefresh: () => void
}) {
  const qc = useQueryClient()
  const [assignProfileId, setAssignProfileId] = useState('')
  const [ops, setOps]     = useState<BulkOp[] | null>(null)
  const [running, setRunning] = useState(false)

  const selectedDevices = devices.filter(d => selected.has(d.id))

  function updateOp(id: string, patch: Partial<BulkOp>) {
    setOps(prev => prev ? prev.map(o => o.id === id ? { ...o, ...patch } : o) : prev)
  }

  async function runBulk(_label: string, fn: (d: Device) => Promise<void>) {
    setRunning(true)
    setOps(selectedDevices.map(d => ({ id: d.id, status: 'pending' })))
    await Promise.allSettled(
      selectedDevices.map(async d => {
        try {
          await fn(d)
          updateOp(d.id, { status: 'ok' })
        } catch (e: unknown) {
          updateOp(d.id, { status: 'error', message: e instanceof Error ? e.message : String(e) })
        }
      })
    )
    setRunning(false)
    qc.invalidateQueries({ queryKey: ['devices'] })
    onRefresh()
  }

  async function handleAssignProfile() {
    if (!assignProfileId) return
    await runBulk('assign', async (d) => {
      await api.put(`/api/v1/devices/${d.id}`, { ...d, profile_id: assignProfileId })
    })
  }

  async function handleFirmwareRefresh() {
    await runBulk('firmware', async (d) => {
      await api.post(`/api/v1/devices/${d.id}/firmware-version`, {})
    })
  }

  async function handlePushConfig() {
    await runBulk('push', async (d) => {
      await api.post(`/api/v1/devices/${d.id}/push-config`, {})
    })
  }

  async function handleDelete() {
    if (!confirm(`Delete ${selected.size} device${selected.size !== 1 ? 's' : ''}?`)) return
    await runBulk('delete', async (d) => {
      await api.delete(`/api/v1/devices/${d.id}`)
    })
    onClear()
  }

  if (ops) {
    const done    = ops.filter(o => o.status !== 'pending').length
    const errors  = ops.filter(o => o.status === 'error')
    const allDone = done === ops.length
    return (
      <div className="mb-4 rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium">
            {running ? `Processing… ${done}/${ops.length}` : `Done — ${ops.length - errors.length} succeeded, ${errors.length} failed`}
          </p>
          {allDone && (
            <button onClick={() => { setOps(null); onClear() }}
              className="text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
          )}
        </div>
        <div className="space-y-1 max-h-40 overflow-auto">
          {ops.map(op => {
            const d = devices.find(x => x.id === op.id)
            return (
              <div key={op.id} className="flex items-center gap-2 text-xs">
                {op.status === 'pending' && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
                {op.status === 'ok'      && <CheckCircle className="h-3 w-3 text-green-600" />}
                {op.status === 'error'   && <XCircle     className="h-3 w-3 text-destructive" />}
                <span className="font-medium">{d?.hostname ?? d?.serial ?? op.id.slice(0, 8)}</span>
                {op.message && <span className="text-destructive">{op.message}</span>}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="mb-4 rounded-lg border bg-primary/5 border-primary/20 px-4 py-3 flex items-center gap-3 flex-wrap">
      <span className="text-sm font-medium text-primary">{selected.size} selected</span>
      <div className="h-4 w-px bg-border" />

      {/* Assign profile */}
      <div className="flex items-center gap-1.5">
        <select value={assignProfileId} onChange={e => setAssignProfileId(e.target.value)}
          className="text-xs border rounded px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary/50">
          <option value="">Assign profile…</option>
          {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button onClick={handleAssignProfile} disabled={!assignProfileId || running}
          className="text-xs px-2.5 py-1 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40">
          Apply
        </button>
      </div>

      <div className="h-4 w-px bg-border" />

      <button onClick={handleFirmwareRefresh} disabled={running}
        className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border hover:bg-accent disabled:opacity-40">
        <Cpu className="h-3.5 w-3.5" /> Check Firmware
      </button>

      <button onClick={handlePushConfig} disabled={running}
        className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border hover:bg-accent disabled:opacity-40">
        <GitCompare className="h-3.5 w-3.5" /> Push Config
      </button>

      <div className="ml-auto flex items-center gap-2">
        <button onClick={handleDelete} disabled={running}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-destructive/40 text-destructive hover:bg-destructive/10 disabled:opacity-40">
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </button>
        <button onClick={onClear} className="text-xs text-muted-foreground hover:text-foreground px-2">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

const VENDORS = ['cisco', 'juniper', 'aruba', 'extreme', 'fortinet', 'other']

function NewDeviceModal({ profiles, onClose }: { profiles: DeviceProfile[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [hostname,    setHostname]    = useState('')
  const [mac,         setMac]         = useState('')
  const [serial,      setSerial]      = useState('')
  const [vendor,      setVendor]      = useState('')
  const [description, setDescription] = useState('')
  const [profileId,   setProfileId]   = useState('')
  const [error,       setError]       = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => {
      if (!mac.trim() && !serial.trim()) {
        throw new Error('At least one of MAC or Serial is required')
      }
      return api.post<Device>('/api/v1/devices', {
        hostname:     hostname     || undefined,
        mac:          mac.trim()   || undefined,
        serial:       serial.trim() || undefined,
        vendor_class: vendor       || undefined,
        description:  description  || undefined,
        profile_id:   profileId    || undefined,
        variables:    {},
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] })
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-background border rounded-xl shadow-xl w-full max-w-md">
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <p className="font-semibold text-sm">Add Device</p>
            <button onClick={onClose}><X className="h-4 w-4" /></button>
          </div>
          <div className="px-5 py-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">MAC Address</label>
                <input value={mac} onChange={e => setMac(e.target.value)}
                  placeholder="aa:bb:cc:dd:ee:ff"
                  className="w-full text-sm font-mono border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Serial Number</label>
                <input value={serial} onChange={e => setSerial(e.target.value)}
                  placeholder="e.g. FXS1234ABCD"
                  className="w-full text-sm font-mono border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground -mt-2">At least one of MAC or Serial is required.</p>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Hostname</label>
              <input value={hostname} onChange={e => setHostname(e.target.value)}
                placeholder="e.g. sw-core-01"
                className="w-full text-sm border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Vendor</label>
                <select value={vendor} onChange={e => setVendor(e.target.value)}
                  className="w-full text-sm border rounded px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/50">
                  <option value="">— Select —</option>
                  {VENDORS.map(v => <option key={v} value={v} className="capitalize">{VENDOR_DISPLAY[v] ?? v}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Model / Description</label>
                <input value={description} onChange={e => setDescription(e.target.value)}
                  placeholder="e.g. FortiSwitch 148F"
                  className="w-full text-sm border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Profile <span className="font-normal text-muted-foreground/60">(optional)</span></label>
              <select value={profileId} onChange={e => setProfileId(e.target.value)}
                className="w-full text-sm border rounded px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/50">
                <option value="">— No profile —</option>
                {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="px-5 py-4 border-t flex justify-end gap-2">
            <button onClick={onClose}
              className="text-sm px-4 py-1.5 rounded border hover:bg-accent">Cancel</button>
            <button onClick={() => save.mutate()} disabled={save.isPending}
              className="text-sm px-4 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {save.isPending ? 'Adding…' : 'Add Device'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

export default function DevicesPage() {
  const [selected,      setSelected]    = useState<Device | null>(null)
  const [terminalDevice, setTerminal]   = useState<Device | null>(null)
  const [diffDevice,    setDiffDevice]  = useState<Device | null>(null)
  const [checkedIds,    setCheckedIds]  = useState<Set<string>>(new Set())
  const [showNewDevice, setShowNewDevice] = useState(false)

  const { data: devices, isLoading, error, refetch, isFetching } = useQuery<Device[]>({
    queryKey: ['devices'],
    queryFn: () => api.get<Device[]>('/api/v1/devices'),
    refetchInterval: 30_000,
  })
  const { data: profiles = [] } = useQuery<DeviceProfile[]>({
    queryKey: ['profiles'],
    queryFn: () => api.get<DeviceProfile[]>('/api/v1/profiles'),
  })
  const { data: leases = [] } = useQuery<DHCPLease[]>({
    queryKey: ['leases'],
    queryFn: () => api.get<DHCPLease[]>('/api/v1/leases'),
    refetchInterval: 30_000,
  })

  function getLeaseForDevice(d: Device): DHCPLease | undefined {
    return leases.find(l =>
      (d.hostname && l.hostname === d.hostname) ||
      (d.mac && l.hw_address === d.mac)
    )
  }

  function toggleCheck(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    setCheckedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (!devices) return
    if (checkedIds.size === devices.length) {
      setCheckedIds(new Set())
    } else {
      setCheckedIds(new Set(devices.map(d => d.id)))
    }
  }

  const allChecked = !!devices && devices.length > 0 && checkedIds.size === devices.length
  const someChecked = checkedIds.size > 0

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Server className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Devices</h1>
          {devices && (
            <span className="text-sm text-muted-foreground">({devices.length})</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowNewDevice(true)}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Add Device
          </button>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {isLoading && <div className="text-muted-foreground text-sm">Loading devices…</div>}
      {error && <div className="text-destructive text-sm">Failed to load devices: {error.message}</div>}

      {devices && devices.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <Server className="h-12 w-12 mx-auto mb-4 opacity-30" />
          <p className="font-medium">No devices yet</p>
          <p className="text-sm">Devices appear here when they connect via DHCP or PnP.</p>
        </div>
      )}

      {devices && devices.length > 0 && (
        <>
          {someChecked && (
            <BulkActionBar
              selected={checkedIds}
              devices={devices}
              profiles={profiles}
              onClear={() => setCheckedIds(new Set())}
              onRefresh={() => refetch()}
            />
          )}
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  <th className="px-4 py-3 w-8">
                    <input type="checkbox" checked={allChecked} onChange={toggleAll}
                      className="rounded border-gray-300 cursor-pointer" />
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Hostname</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">IP</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">MAC</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Serial</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Vendor / Model</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">ZTP Method</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Profile</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Firmware</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Last Seen</th>
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {devices.map((d, i) => {
                  const profile  = profiles.find(p => p.id === d.profile_id)
                  const lease    = getLeaseForDevice(d)
                  const vendor   = d.vendor_class ? (VENDOR_DISPLAY[d.vendor_class] ?? d.vendor_class) : null
                  const model    = d.description ?? null
                  const checked  = checkedIds.has(d.id)
                  return (
                    <tr
                      key={d.id}
                      onClick={() => setSelected(d)}
                      className={`group cursor-pointer hover:bg-muted/40 transition-colors ${checked ? 'bg-primary/5' : i % 2 === 0 ? '' : 'bg-muted/20'}`}
                    >
                      <td className="px-4 py-3" onClick={e => toggleCheck(d.id, e)}>
                        <input type="checkbox" checked={checked} onChange={() => {}}
                          className="rounded border-gray-300 cursor-pointer" />
                      </td>
                      <td className="px-4 py-3 font-medium">{d.hostname ?? <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-4 py-3 font-mono text-xs">{lease?.ip_address ?? '—'}</td>
                      <td className="px-4 py-3 font-mono text-xs">{d.mac ?? lease?.hw_address ?? '—'}</td>
                      <td className="px-4 py-3 font-mono text-xs">{d.serial ?? '—'}</td>
                      <td className="px-4 py-3 text-xs">
                        {vendor || model
                          ? <span>{[vendor, model].filter(Boolean).join(' ')}</span>
                          : <span className="text-muted-foreground">—</span>
                        }
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {d.vendor_class ? (ZTP_METHOD[d.vendor_class] ?? d.vendor_class) : '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{profile?.name ?? '—'}</td>
                      <td className="px-4 py-3 text-xs font-mono">
                        {d.firmware_version ? (
                          <span className="flex items-center gap-1.5">
                            {d.firmware_version}
                            {profile?.firmware_version && profile.firmware_version !== d.firmware_version && (
                              <span title={`Target: ${profile.firmware_version}`}
                                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 font-sans">
                                update
                              </span>
                            )}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[d.status]}`}>
                          {STATUS_LABELS[d.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">
                        {d.last_seen ? formatRelative(d.last_seen) : '—'}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {lease?.ip_address && (
                          <button
                            onClick={e => { e.stopPropagation(); setTerminal(d) }}
                            title="Open terminal"
                            className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-green-600 text-green-700 hover:bg-green-50"
                          >
                            <Terminal className="h-3.5 w-3.5" />
                            Connect
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {selected && (
        <DeviceDrawer
          device={selected}
          profiles={profiles}
          leases={leases}
          onClose={() => setSelected(null)}
          onTerminal={(d) => { setSelected(null); setTerminal(d) }}
          onDiff={(d) => { setSelected(null); setDiffDevice(d) }}
        />
      )}

      {terminalDevice && (
        <TerminalOverlay device={terminalDevice} onClose={() => setTerminal(null)} />
      )}
      {diffDevice && (
        <DiffModal device={diffDevice} onClose={() => setDiffDevice(null)} />
      )}
      {showNewDevice && (
        <NewDeviceModal profiles={profiles} onClose={() => setShowNewDevice(false)} />
      )}
    </div>
  )
}
