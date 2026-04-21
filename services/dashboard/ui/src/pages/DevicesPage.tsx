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

type DeviceModalTab = 'overview' | 'variables' | 'vlans' | 'ports' | 'config'

interface VlanRow { id: number; name: string; description: string }
interface PortRow { port: string; native_vlan: number; allowed_vlans: string; description: string }

interface VlanEntry extends VlanRow { fromProfile: boolean; overridden: boolean }
interface PortEntry extends PortRow { fromProfile: boolean; overridden: boolean }

function toVlans(v: unknown): VlanRow[] {
  if (!Array.isArray(v)) return []
  return v.map((r: Record<string, unknown>) => ({
    id: Number(r.id ?? 0), name: String(r.name ?? ''), description: String(r.description ?? ''),
  }))
}
function toPorts(v: unknown): PortRow[] {
  if (!Array.isArray(v)) return []
  return v.map((r: Record<string, unknown>) => ({
    port:          String(r.port ?? ''),
    native_vlan:   Number(r.native_vlan ?? 1),
    allowed_vlans: String(r.allowed_vlans ?? ''),
    description:   String(r.description ?? ''),
  }))
}

function initVlans(profileVlans: VlanRow[], deviceVlans: VlanRow[]): VlanEntry[] {
  const rows: VlanEntry[] = profileVlans.map(pv => {
    const override = deviceVlans.find(dv => dv.id === pv.id)
    return { ...(override ?? pv), fromProfile: true, overridden: !!override }
  })
  deviceVlans.filter(dv => !profileVlans.some(pv => pv.id === dv.id))
    .forEach(dv => rows.push({ ...dv, fromProfile: false, overridden: false }))
  return rows
}
function initPorts(profilePorts: PortRow[], devicePorts: PortRow[]): PortEntry[] {
  const rows: PortEntry[] = profilePorts.map(pp => {
    const override = devicePorts.find(dp => dp.port === pp.port)
    return { ...(override ?? pp), fromProfile: true, overridden: !!override }
  })
  devicePorts.filter(dp => !profilePorts.some(pp => pp.port === dp.port))
    .forEach(dp => rows.push({ ...dp, fromProfile: false, overridden: false }))
  return rows
}

function DeviceModal({
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
  const [tab,          setTab]          = useState<DeviceModalTab>('overview')
  const [hostname,     setHostname]     = useState(device.hostname ?? '')
  const [description,  setDescription]  = useState(device.description ?? '')
  const [profileId,    setProfileId]    = useState(device.profile_id ?? '')
  const [managementIp, setManagementIp] = useState(device.management_ip ?? '')
  const [vars, setVars] = useState<[string, string][]>(
    Object.entries(device.variables ?? {}).map(([k, v]) => [k, String(v)])
  )
  const [firmwareVersion,    setFirmwareVersion]    = useState(device.firmware_version ?? null)
  const [firmwareCheckedAt,  setFirmwareCheckedAt]  = useState(device.firmware_checked_at ?? null)
  const [refreshingFirmware, setRefreshingFirmware] = useState(false)
  const [downloading,        setDownloading]        = useState(false)
  const [downloadingRunning, setDownloadingRunning] = useState(false)
  const [pushing,            setPushing]            = useState(false)
  const [pushResult,         setPushResult]         = useState<{ success: boolean; output: string } | null>(null)
  const [error,              setError]              = useState<string | null>(null)

  const lease = leases.find(l =>
    (device.hostname && l.hostname === device.hostname) ||
    (device.mac && l.hw_address === device.mac)
  )
  const profile = profiles.find(p => p.id === (profileId || device.profile_id))

  const profileVlans = toVlans(profile?.variables?.vlans)
  const profilePorts = toPorts(profile?.variables?.ports)
  const [vlans, setVlans] = useState<VlanEntry[]>(() =>
    initVlans(toVlans(profile?.variables?.vlans), toVlans(device.variables?.vlans))
  )
  const [ports, setPorts] = useState<PortEntry[]>(() =>
    initPorts(toPorts(profile?.variables?.ports), toPorts(device.variables?.ports))
  )

  const save = useMutation({
    mutationFn: (body: Partial<Device>) => api.put<Device>(`/api/v1/devices/${device.id}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['devices'] }); onClose() },
    onError: (e: Error) => setError(e.message),
  })

  const del = useMutation({
    mutationFn: () => api.delete(`/api/v1/devices/${device.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['devices'] }); onClose() },
    onError: (e: Error) => setError(e.message),
  })

  function handleSave() {
    setError(null)
    const variables: Record<string, unknown> = Object.fromEntries(vars.filter(([k]) => k.trim() !== ''))
    // Only save device-level vlan/port rows (overrides + new)
    const deviceVlans = vlans.filter(v => !v.fromProfile || v.overridden)
      .map(({ id, name, description }) => ({ id, name, description }))
    const devicePorts = ports.filter(p => !p.fromProfile || p.overridden)
      .map(({ port, native_vlan, allowed_vlans, description }) => ({
        port, native_vlan, description,
        ...(allowed_vlans.trim() ? { allowed_vlans: allowed_vlans.trim() } : {}),
      }))
    if (deviceVlans.length > 0) variables.vlans = deviceVlans
    if (devicePorts.length > 0) variables.ports = devicePorts
    save.mutate({ ...device, hostname: hostname || undefined, description: description || undefined,
      profile_id: profileId || undefined, management_ip: managementIp || undefined, variables })
  }

  async function handleRefreshFirmware() {
    setRefreshingFirmware(true); setError(null)
    try {
      const res = await api.post<{ firmware_version: string }>(`/api/v1/devices/${device.id}/firmware-version`, {})
      setFirmwareVersion(res.firmware_version)
      setFirmwareCheckedAt(new Date().toISOString())
      qc.invalidateQueries({ queryKey: ['devices'] })
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Firmware check failed') }
    finally { setRefreshingFirmware(false) }
  }

  async function handleDownload() {
    setDownloading(true); setError(null)
    try { await downloadConfig(device.id, device.hostname ?? device.serial ?? device.id) }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Download failed') }
    finally { setDownloading(false) }
  }

  async function handleDownloadRunning() {
    setDownloadingRunning(true); setError(null)
    try { await downloadRunningConfig(device.id, device.hostname ?? device.serial ?? device.id) }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed to pull running config') }
    finally { setDownloadingRunning(false) }
  }

  async function handlePush() {
    if (!confirm('Replace the running config with the rendered config?')) return
    setPushing(true); setError(null); setPushResult(null)
    try {
      const res = await api.post<{ success: boolean; output: string }>(`/api/v1/devices/${device.id}/push-config`, {})
      setPushResult(res)
    } catch (e: unknown) {
      setPushResult({ success: false, output: e instanceof Error ? e.message : 'Push failed' })
    } finally { setPushing(false) }
  }

  function addVar()             { setVars(v => [...v, ['', '']]) }
  function removeVar(i: number) { setVars(v => v.filter((_, j) => j !== i)) }
  function setVarKey(i: number, k: string) { setVars(v => v.map((p, j) => j === i ? [k, p[1]] : p)) }
  function setVarVal(i: number, val: string) { setVars(v => v.map((p, j) => j === i ? [p[0], val] : p)) }

  const TABS: { id: DeviceModalTab; label: string }[] = [
    { id: 'overview',  label: 'Overview'  },
    { id: 'variables', label: 'Variables' },
    { id: 'vlans',     label: 'VLANs'     },
    { id: 'ports',     label: 'Ports'     },
    { id: 'config',    label: 'Config'    },
  ]

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-background border rounded-xl shadow-2xl w-full max-w-3xl flex flex-col max-h-[85vh]">

          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
            <div>
              <p className="font-semibold text-sm">{device.hostname ?? device.serial ?? device.mac ?? device.id}</p>
              {device.description && <p className="text-xs text-muted-foreground">{device.description}</p>}
            </div>
            <div className="flex items-center gap-2">
              {(lease?.ip_address || device.management_ip) && (
                <button onClick={() => { onClose(); onTerminal(device) }}
                  title="Open terminal"
                  className="p-1.5 rounded border border-green-600 text-green-700 hover:bg-green-50">
                  <Terminal className="h-4 w-4" />
                </button>
              )}
              <button onClick={onClose} className="p-1.5 rounded hover:bg-accent">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b shrink-0 px-5">
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  tab === t.id
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-5">

            {/* ── Overview ── */}
            {tab === 'overview' && (
              <div className="space-y-5">
                <div className="grid grid-cols-3 gap-4 text-sm">
                  {[
                    ['Serial',      device.serial ?? '—',                              'font-mono text-xs'],
                    ['MAC',         device.mac ?? lease?.hw_address ?? '—',            'font-mono text-xs'],
                    ['IP',          lease?.ip_address ?? device.management_ip ?? '—',  'font-mono text-xs font-medium text-primary'],
                    ['Status',      null,                                               ''],
                    ['Vendor',      device.vendor_class ? (VENDOR_DISPLAY[device.vendor_class] ?? device.vendor_class) : '—', 'text-xs'],
                    ['ZTP Method',  device.vendor_class ? (ZTP_METHOD[device.vendor_class] ?? '—') : '—', 'text-xs'],
                    ['Last Seen',   device.last_seen ? formatRelative(device.last_seen) : '—',         'text-xs'],
                    ['Provisioned', device.provisioned_at ? formatRelative(device.provisioned_at) : '—', 'text-xs'],
                  ].map(([label, val, cls]) => (
                    <div key={label as string}>
                      <p className="text-xs text-muted-foreground mb-1">{label as string}</p>
                      {label === 'Status'
                        ? <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[device.status]}`}>{STATUS_LABELS[device.status]}</span>
                        : <p className={cls as string}>{val as string}</p>
                      }
                    </div>
                  ))}
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Firmware</p>
                    <div className="flex items-center gap-1.5">
                      <Cpu className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="text-xs font-mono">{firmwareVersion ?? '—'}</span>
                      {profile?.firmware_version && firmwareVersion && profile.firmware_version !== firmwareVersion && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
                          target: {profile.firmware_version}
                        </span>
                      )}
                    </div>
                    {firmwareCheckedAt && <p className="text-[10px] text-muted-foreground mt-0.5">checked {formatRelative(firmwareCheckedAt)}</p>}
                    <button onClick={handleRefreshFirmware} disabled={refreshingFirmware}
                      className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">
                      <RefreshCw className={`h-3 w-3 ${refreshingFirmware ? 'animate-spin' : ''}`} />
                      {refreshingFirmware ? 'Checking…' : 'Refresh'}
                    </button>
                  </div>
                </div>

                <div className="border-t pt-4 grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">Hostname</label>
                    <input value={hostname} onChange={e => setHostname(e.target.value)} placeholder="sw-core-01"
                      className="w-full text-sm border rounded px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">Model / Description</label>
                    <input value={description} onChange={e => setDescription(e.target.value)} placeholder="EX2300-24P"
                      className="w-full text-sm border rounded px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">Profile</label>
                    <select value={profileId} onChange={e => setProfileId(e.target.value)}
                      className="w-full text-sm border rounded px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/50">
                      <option value="">— No profile —</option>
                      {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      Management IP <span className="font-normal text-muted-foreground/60">(optional)</span>
                    </label>
                    <input value={managementIp} onChange={e => setManagementIp(e.target.value)} placeholder="10.0.0.50"
                      className="w-full text-sm font-mono border rounded px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                </div>
              </div>
            )}

            {/* ── Variables ── */}
            {tab === 'variables' && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-muted-foreground">Device-level variables override profile variables.</p>
                  <button onClick={addVar}
                    className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded border hover:bg-accent">
                    <Plus className="h-3 w-3" /> Add variable
                  </button>
                </div>
                {vars.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-8">No variables set.</p>
                )}
                <div className="space-y-2">
                  {vars.map(([k, v], i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input value={k} onChange={e => setVarKey(i, e.target.value)} placeholder="key"
                        className="w-48 text-sm border rounded px-3 py-1.5 bg-background font-mono focus:outline-none focus:ring-1 focus:ring-primary/50" />
                      <input value={v} onChange={e => setVarVal(i, e.target.value)} placeholder="value"
                        className="flex-1 text-sm border rounded px-3 py-1.5 bg-background font-mono focus:outline-none focus:ring-1 focus:ring-primary/50" />
                      <button onClick={() => removeVar(i)} className="text-muted-foreground hover:text-destructive shrink-0">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── VLANs ── */}
            {tab === 'vlans' && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-muted-foreground">
                    Profile VLANs shown greyed-out. Check Override to edit in-place.
                  </p>
                  <button
                    onClick={() => setVlans(v => [...v, { id: 0, name: '', description: '', fromProfile: false, overridden: false }])}
                    className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded border hover:bg-accent">
                    <Plus className="h-3 w-3" /> Add VLAN
                  </button>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b">
                      <th className="text-left pb-2 w-8">OVR</th>
                      <th className="text-left pb-2 w-20">ID</th>
                      <th className="text-left pb-2">Name</th>
                      <th className="text-left pb-2">Description</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {vlans.map((v, i) => {
                      const disabled = v.fromProfile && !v.overridden
                      return (
                        <tr key={i} className={disabled ? 'opacity-40' : ''}>
                          <td className="py-1.5 pr-2">
                            {v.fromProfile && (
                              <input type="checkbox" checked={v.overridden}
                                onChange={e => {
                                  const overriding = e.target.checked
                                  setVlans(rows => rows.map((r, j) => {
                                    if (j !== i) return r
                                    if (!overriding) {
                                      const orig = profileVlans.find(p => p.id === r.id)
                                      return { ...r, ...(orig ?? {}), overridden: false }
                                    }
                                    return { ...r, overridden: true }
                                  }))
                                }}
                                className="rounded cursor-pointer" />
                            )}
                          </td>
                          <td className="py-1.5 pr-2">
                            <input type="number" value={v.id} disabled={disabled}
                              onChange={e => setVlans(rows => rows.map((r, j) => j === i ? { ...r, id: Number(e.target.value) } : r))}
                              className="w-16 text-sm border rounded px-2 py-1 font-mono disabled:bg-transparent disabled:border-transparent focus:outline-none focus:ring-1 focus:ring-primary/50" />
                          </td>
                          <td className="py-1.5 pr-2">
                            <input type="text" value={v.name} disabled={disabled} placeholder="Users"
                              onChange={e => setVlans(rows => rows.map((r, j) => j === i ? { ...r, name: e.target.value } : r))}
                              className="w-full text-sm border rounded px-2 py-1 disabled:bg-transparent disabled:border-transparent focus:outline-none focus:ring-1 focus:ring-primary/50" />
                          </td>
                          <td className="py-1.5 pr-2">
                            <input type="text" value={v.description} disabled={disabled} placeholder="Optional"
                              onChange={e => setVlans(rows => rows.map((r, j) => j === i ? { ...r, description: e.target.value } : r))}
                              className="w-full text-sm border rounded px-2 py-1 disabled:bg-transparent disabled:border-transparent focus:outline-none focus:ring-1 focus:ring-primary/50" />
                          </td>
                          <td className="py-1.5">
                            {!v.fromProfile && (
                              <button onClick={() => setVlans(rows => rows.filter((_, j) => j !== i))}
                                className="text-muted-foreground hover:text-destructive">
                                <X className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {vlans.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-8">No VLANs defined in profile or device.</p>
                )}
              </div>
            )}

            {/* ── Ports ── */}
            {tab === 'ports' && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-muted-foreground">
                    Profile ports shown greyed-out. Check Override to edit in-place.
                  </p>
                  <button
                    onClick={() => setPorts(p => [...p, { port: '', native_vlan: 1, allowed_vlans: '', description: '', fromProfile: false, overridden: false }])}
                    className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded border hover:bg-accent">
                    <Plus className="h-3 w-3" /> Add Port
                  </button>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b">
                      <th className="text-left pb-2 w-8">OVR</th>
                      <th className="text-left pb-2">Port</th>
                      <th className="text-left pb-2 w-24">Native VLAN</th>
                      <th className="text-left pb-2">Allowed VLANs <span className="font-normal opacity-60">(optional)</span></th>
                      <th className="text-left pb-2">Description</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {ports.map((p, i) => {
                      const disabled = p.fromProfile && !p.overridden
                      return (
                        <tr key={i} className={disabled ? 'opacity-40' : ''}>
                          <td className="py-1.5 pr-2">
                            {p.fromProfile && (
                              <input type="checkbox" checked={p.overridden}
                                onChange={e => {
                                  const overriding = e.target.checked
                                  setPorts(rows => rows.map((r, j) => {
                                    if (j !== i) return r
                                    if (!overriding) {
                                      const orig = profilePorts.find(pp => pp.port === r.port)
                                      return { ...r, ...(orig ?? {}), overridden: false }
                                    }
                                    return { ...r, overridden: true }
                                  }))
                                }}
                                className="rounded cursor-pointer" />
                            )}
                          </td>
                          <td className="py-1.5 pr-2">
                            <input type="text" value={p.port} disabled={disabled} placeholder="ge-0/0/0"
                              onChange={e => setPorts(rows => rows.map((r, j) => j === i ? { ...r, port: e.target.value } : r))}
                              className="w-full text-sm border rounded px-2 py-1 font-mono disabled:bg-transparent disabled:border-transparent focus:outline-none focus:ring-1 focus:ring-primary/50" />
                          </td>
                          <td className="py-1.5 pr-2">
                            <input type="number" value={p.native_vlan} disabled={disabled}
                              onChange={e => setPorts(rows => rows.map((r, j) => j === i ? { ...r, native_vlan: Number(e.target.value) } : r))}
                              className="w-20 text-sm border rounded px-2 py-1 font-mono disabled:bg-transparent disabled:border-transparent focus:outline-none focus:ring-1 focus:ring-primary/50" />
                          </td>
                          <td className="py-1.5 pr-2">
                            <input type="text" value={p.allowed_vlans} disabled={disabled} placeholder="10,20,30 or 10-50"
                              onChange={e => setPorts(rows => rows.map((r, j) => j === i ? { ...r, allowed_vlans: e.target.value } : r))}
                              className="w-full text-sm border rounded px-2 py-1 font-mono disabled:bg-transparent disabled:border-transparent focus:outline-none focus:ring-1 focus:ring-primary/50" />
                          </td>
                          <td className="py-1.5 pr-2">
                            <input type="text" value={p.description} disabled={disabled} placeholder="Optional"
                              onChange={e => setPorts(rows => rows.map((r, j) => j === i ? { ...r, description: e.target.value } : r))}
                              className="w-full text-sm border rounded px-2 py-1 disabled:bg-transparent disabled:border-transparent focus:outline-none focus:ring-1 focus:ring-primary/50" />
                          </td>
                          <td className="py-1.5">
                            {!p.fromProfile && (
                              <button onClick={() => setPorts(rows => rows.filter((_, j) => j !== i))}
                                className="text-muted-foreground hover:text-destructive">
                                <X className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {ports.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-8">No ports defined in profile or device.</p>
                )}
              </div>
            )}

            {/* ── Config ── */}
            {tab === 'config' && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <button onClick={handleDownload} disabled={downloading || !profileId}
                    className="flex items-center justify-center gap-2 border rounded-lg p-4 hover:bg-accent disabled:opacity-40 text-sm">
                    <Download className="h-4 w-4" />
                    {downloading ? 'Downloading…' : 'Download Rendered Config'}
                  </button>
                  <button onClick={handleDownloadRunning} disabled={downloadingRunning}
                    className="flex items-center justify-center gap-2 border rounded-lg p-4 hover:bg-accent disabled:opacity-40 text-sm">
                    <Download className="h-4 w-4" />
                    {downloadingRunning ? 'Pulling…' : 'Download Running Config'}
                  </button>
                  <button onClick={() => { onClose(); onDiff(device) }} disabled={!profileId}
                    className="flex items-center justify-center gap-2 border rounded-lg p-4 hover:bg-accent disabled:opacity-40 text-sm">
                    <GitCompare className="h-4 w-4" />
                    View Config Diff
                  </button>
                  <button onClick={handlePush} disabled={pushing || !profileId}
                    className="flex items-center justify-center gap-2 border border-amber-300 rounded-lg p-4 hover:bg-amber-50 disabled:opacity-40 text-sm text-amber-700">
                    <GitCompare className="h-4 w-4" />
                    {pushing ? 'Pushing…' : 'Push Config to Device'}
                  </button>
                </div>
                {!profileId && (
                  <p className="text-xs text-muted-foreground text-center">Assign a profile to enable config actions.</p>
                )}
                {pushResult && (
                  <div className={`rounded-lg p-3 text-xs font-mono ${pushResult.success ? 'bg-green-950/20 text-green-700' : 'bg-red-950/20 text-red-700'}`}>
                    <p className="font-semibold mb-1">{pushResult.success ? '✓ Push successful' : '✗ Push failed'}</p>
                    <pre className="whitespace-pre-wrap">{pushResult.output}</pre>
                  </div>
                )}
              </div>
            )}

            {error && <p className="text-xs text-destructive mt-4">{error}</p>}
          </div>

          {/* Footer */}
          <div className="border-t px-5 py-3 flex items-center justify-between shrink-0">
            <button onClick={() => { if (confirm('Delete this device?')) del.mutate() }}
              disabled={del.isPending}
              className="p-1.5 text-destructive hover:opacity-80 disabled:opacity-50 rounded hover:bg-destructive/10">
              <Trash2 className="h-4 w-4" />
            </button>
            <div className="flex gap-2">
              <button onClick={onClose} className="text-sm px-4 py-1.5 rounded border hover:bg-accent">Cancel</button>
              <button onClick={handleSave} disabled={save.isPending}
                className="text-sm px-4 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
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
  const [hostname,     setHostname]     = useState('')
  const [mac,          setMac]          = useState('')
  const [serial,       setSerial]       = useState('')
  const [vendor,       setVendor]       = useState('')
  const [description,  setDescription]  = useState('')
  const [profileId,    setProfileId]    = useState('')
  const [managementIp, setManagementIp] = useState('')
  const [sshUsername,  setSshUsername]  = useState('admin')
  const [sshPassword,  setSshPassword]  = useState('')
  const [error,        setError]        = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => {
      if (!mac.trim() && !serial.trim()) {
        throw new Error('At least one of MAC or Serial is required')
      }
      const variables: Record<string, string> = {}
      if (sshUsername) variables['ssh_username'] = sshUsername
      if (sshPassword) variables['local_password'] = sshPassword
      return api.post<Device>('/api/v1/devices', {
        hostname:      hostname       || undefined,
        mac:           mac.trim()     || undefined,
        serial:        serial.trim()  || undefined,
        vendor_class:  vendor         || undefined,
        description:   description    || undefined,
        profile_id:    profileId      || undefined,
        management_ip: managementIp   || undefined,
        variables,
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
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Management IP <span className="font-normal text-muted-foreground/60">(optional if using DHCP)</span>
              </label>
              <input value={managementIp} onChange={e => setManagementIp(e.target.value)}
                placeholder="e.g. 10.0.0.50"
                className="w-full text-sm font-mono border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">SSH Username</label>
                <input value={sshUsername} onChange={e => setSshUsername(e.target.value)}
                  placeholder="admin"
                  className="w-full text-sm font-mono border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">SSH Password</label>
                <input type="password" value={sshPassword} onChange={e => setSshPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full text-sm font-mono border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50" />
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
        <DeviceModal
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
