import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type Device, type DeviceProfile, type DHCPLease } from '@/lib/api'
import { formatRelative } from '@/lib/utils'
import { Server, RefreshCw, X, Plus, Trash2, Terminal, Download } from 'lucide-react'

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
}: {
  device: Device
  profiles: DeviceProfile[]
  leases: DHCPLease[]
  onClose: () => void
  onTerminal: (d: Device) => void
}) {
  const qc = useQueryClient()
  const [hostname,    setHostname]    = useState(device.hostname ?? '')
  const [description, setDescription] = useState(device.description ?? '')
  const [profileId,   setProfileId]   = useState(device.profile_id ?? '')
  const [vars, setVars] = useState<[string, string][]>(
    Object.entries(device.variables ?? {}).map(([k, v]) => [k, String(v)])
  )
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

export default function DevicesPage() {
  const [selected, setSelected]       = useState<Device | null>(null)
  const [terminalDevice, setTerminal] = useState<Device | null>(null)

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
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
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
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Hostname</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">IP</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">MAC</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Serial</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Vendor / Model</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">ZTP Method</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Profile</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Last Seen</th>
                <th className="w-16" />
              </tr>
            </thead>
            <tbody>
              {devices.map((d, i) => {
                const profile = profiles.find(p => p.id === d.profile_id)
                const lease   = getLeaseForDevice(d)
                const vendor  = d.vendor_class ? (VENDOR_DISPLAY[d.vendor_class] ?? d.vendor_class) : null
                const model   = d.description ?? null
                return (
                  <tr
                    key={d.id}
                    onClick={() => setSelected(d)}
                    className={`group cursor-pointer hover:bg-muted/40 transition-colors ${i % 2 === 0 ? '' : 'bg-muted/20'}`}
                  >
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
      )}

      {selected && (
        <DeviceDrawer
          device={selected}
          profiles={profiles}
          leases={leases}
          onClose={() => setSelected(null)}
          onTerminal={(d) => { setSelected(null); setTerminal(d) }}
        />
      )}

      {terminalDevice && (
        <TerminalOverlay device={terminalDevice} onClose={() => setTerminal(null)} />
      )}
    </div>
  )
}
