import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type ConfigTemplate, type DeviceProfile, type Customer } from '@/lib/api'
import { Users, Plus, Trash2, X, Wand2, Building2, ChevronDown, RefreshCw } from 'lucide-react'

const VENDOR_COLORS: Record<string, string> = {
  cisco:    'bg-blue-100 text-blue-700',
  aruba:    'bg-orange-100 text-orange-700',
  juniper:  'bg-green-100 text-green-700',
  extreme:  'bg-purple-100 text-purple-700',
  fortinet: 'bg-red-100 text-red-700',
}

type PortMode = 'access' | 'trunk' | 'uplink' | 'disabled'
interface PortEntry { port: number; description: string; mode: PortMode; vlan: string }

const PORT_PRESETS = [8, 12, 24, 48]
const MODE_OPTS: { value: PortMode; label: string }[] = [
  { value: 'access',   label: 'Access'   },
  { value: 'trunk',    label: 'Trunk'    },
  { value: 'uplink',   label: 'Uplink'   },
  { value: 'disabled', label: 'Disabled' },
]

// ── Customer Form ──────────────────────────────────────────────────────────────

function CustomerForm({ initial, onClose }: { initial?: Customer; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState(initial?.name ?? '')
  const [desc, setDesc] = useState(initial?.description ?? '')
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => {
      const body = { name, description: desc || undefined }
      return initial
        ? api.put<Customer>(`/api/v1/customers/${initial.id}`, body)
        : api.post<Customer>('/api/v1/customers', body)
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['customers'] }); onClose() },
    onError: (e: Error) => setError(e.message),
  })

  const del = useMutation({
    mutationFn: () => api.delete(`/api/v1/customers/${initial!.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['customers'] }); onClose() },
    onError: (e: Error) => setError(e.message),
  })

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-background border rounded-lg shadow-xl w-full max-w-sm">
          <div className="flex items-center justify-between px-5 py-4 border-b">
            <p className="font-semibold text-sm">{initial ? 'Edit Customer' : 'New Customer'}</p>
            <button onClick={onClose}><X className="h-4 w-4" /></button>
          </div>
          <div className="px-5 py-4 space-y-4">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Name</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Acme Corp"
                className="w-full text-sm border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Description</label>
              <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional"
                className="w-full text-sm border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="px-5 py-4 border-t flex items-center justify-between">
            {initial ? (
              <button onClick={() => { if (confirm('Delete this customer? Profiles will be unlinked.')) del.mutate() }}
                className="flex items-center gap-1.5 text-sm text-destructive hover:opacity-80">
                <Trash2 className="h-4 w-4" /> Delete
              </button>
            ) : <div />}
            <div className="flex gap-2">
              <button onClick={onClose} className="text-sm px-4 py-2 rounded border hover:bg-accent">Cancel</button>
              <button onClick={() => save.mutate()} disabled={save.isPending}
                className="text-sm px-4 py-2 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ── Profile Form ───────────────────────────────────────────────────────────────

type Tab = 'general' | 'vlans' | 'ports' | 'vars'

function ProfileForm({
  initial, templates, customers, onClose,
}: {
  initial?: DeviceProfile
  templates: ConfigTemplate[]
  customers: Customer[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('general')

  // General
  const [name,            setName]            = useState(initial?.name ?? '')
  const [desc,            setDesc]            = useState(initial?.description ?? '')
  const [customerId,      setCustomerId]      = useState(initial?.customer_id ?? '')
  const [templateId,      setTemplateId]      = useState(initial?.template_id ?? '')
  const [firmwareVersion, setFirmwareVersion] = useState(initial?.firmware_version ?? '')
  const [error,           setError]           = useState<string | null>(null)
  const [discovering,     setDiscovering]     = useState(false)

  // VLANs — extracted from variables.vlans on load
  const [vlans, setVlans] = useState<[string, string][]>(() => {
    const v = initial?.variables?.vlans
    if (v && typeof v === 'object' && !Array.isArray(v))
      return Object.entries(v as Record<string, unknown>).map(([k, id]) => [k, String(id)])
    return []
  })

  // Port map — extracted from variables.port_map on load
  const [portMap, setPortMap] = useState<PortEntry[]>(() => {
    const pm = initial?.variables?.port_map
    return Array.isArray(pm) ? (pm as PortEntry[]) : []
  })
  const [portCount, setPortCount] = useState(24)

  // Scalar variables (everything except vlans + port_map)
  const [vars, setVars] = useState<[string, string][]>(
    Object.entries(initial?.variables ?? {})
      .filter(([k]) => k !== 'vlans' && k !== 'port_map')
      .map(([k, v]) => [k, String(v)])
  )

  // ── Save ──────────────────────────────────────────────────────────────────────

  const save = useMutation({
    mutationFn: () => {
      const vlanObj = vlans.length > 0
        ? Object.fromEntries(
            vlans.filter(([n]) => n.trim()).map(([n, id]) => [n, isNaN(Number(id)) ? id : Number(id)])
          )
        : undefined
      const variables: Record<string, unknown> = {
        ...Object.fromEntries(vars.filter(([k]) => k.trim())),
        ...(vlanObj ? { vlans: vlanObj } : {}),
        ...(portMap.length > 0 ? { port_map: portMap } : {}),
      }
      const body = {
        name,
        description:      desc            || undefined,
        customer_id:      customerId      || undefined,
        template_id:      templateId      || undefined,
        firmware_version: firmwareVersion || undefined,
        variables,
      }
      return initial
        ? api.put<DeviceProfile>(`/api/v1/profiles/${initial.id}`, { ...initial, ...body })
        : api.post<DeviceProfile>('/api/v1/profiles', body)
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['profiles'] }); onClose() },
    onError: (e: Error) => setError(e.message),
  })

  const del = useMutation({
    mutationFn: () => api.delete(`/api/v1/profiles/${initial!.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['profiles'] }); onClose() },
    onError: (e: Error) => setError(e.message),
  })

  // ── Discover vars ─────────────────────────────────────────────────────────────

  async function discoverVars() {
    if (!templateId) return
    setDiscovering(true)
    setError(null)
    try {
      const result = await api.get<{ variables: string[] }>(`/api/v1/templates/${templateId}/variables`)
      setVars(current => {
        const existing = new Set(current.map(([k]) => k))
        const newVars = result.variables
          .filter(v => !existing.has(v) && v !== 'vlans' && v !== 'port_map')
          .map((v): [string, string] => [v, ''])
        return [...current, ...newVars]
      })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to discover variables')
    } finally {
      setDiscovering(false)
    }
  }

  // ── Port map helpers ──────────────────────────────────────────────────────────

  function generatePorts() {
    setPortMap(Array.from({ length: portCount }, (_, i) => ({
      port:        i + 1,
      description: '',
      mode:        'access' as PortMode,
      vlan:        vlans[0]?.[0] ?? '',
    })))
  }

  function updatePort(i: number, patch: Partial<PortEntry>) {
    setPortMap(pm => pm.map((p, j) => j === i ? { ...p, ...patch } : p))
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const TABS: { id: Tab; label: string }[] = [
    { id: 'general', label: 'General'   },
    { id: 'vlans',   label: 'VLANs'     },
    { id: 'ports',   label: `Port Map${portMap.length > 0 ? ` (${portMap.length})` : ''}` },
    { id: 'vars',    label: 'Variables' },
  ]

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-background border rounded-lg shadow-xl w-full max-w-3xl flex flex-col max-h-[90vh]">

          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
            <p className="font-semibold text-sm">{initial ? 'Edit Profile' : 'New Profile'}</p>
            <button onClick={onClose}><X className="h-4 w-4" /></button>
          </div>

          {/* Tab strip */}
          <div className="flex border-b shrink-0 px-5">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`text-xs font-medium px-4 py-2.5 border-b-2 transition-colors ${
                  tab === t.id
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto px-5 py-4">

            {/* ── General ── */}
            {tab === 'general' && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">Name</label>
                    <input value={name} onChange={e => setName(e.target.value)} placeholder="Cisco C9300 Standard"
                      className="w-full text-sm border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">Customer</label>
                    <select value={customerId} onChange={e => setCustomerId(e.target.value)}
                      className="w-full text-sm border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50">
                      <option value="">— No customer —</option>
                      {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Description</label>
                  <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional"
                    className="w-full text-sm border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Template</label>
                  <select value={templateId} onChange={e => setTemplateId(e.target.value)}
                    className="w-full text-sm border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50">
                    <option value="">— Select template —</option>
                    {templates.map(t => (
                      <option key={t.id} value={t.id}>{t.vendor} / {t.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Target Firmware Version</label>
                  <input value={firmwareVersion} onChange={e => setFirmwareVersion(e.target.value)}
                    placeholder="e.g. 17.12.04"
                    className="w-full text-sm border rounded px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  <p className="text-xs text-muted-foreground mt-1">Devices on this profile will be flagged if their firmware doesn't match.</p>
                </div>
              </div>
            )}

            {/* ── VLANs ── */}
            {tab === 'vlans' && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Define VLANs for this profile. These become the <code className="font-mono bg-muted px-1 rounded">vlans</code> variable
                  in your template — use <code className="font-mono bg-muted px-1 rounded">{"{{ vlans['MGMT'] }}"}</code> to get the VLAN ID.
                </p>
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/50 border-b">
                        <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Name</th>
                        <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">ID</th>
                        <th className="w-8" />
                      </tr>
                    </thead>
                    <tbody>
                      {vlans.map(([name, id], i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="px-3 py-1.5">
                            <input value={name}
                              onChange={e => setVlans(vs => vs.map((v, j) => j === i ? [e.target.value, v[1]] : v))}
                              placeholder="MGMT"
                              className="w-full text-xs font-mono border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary/50" />
                          </td>
                          <td className="px-3 py-1.5">
                            <input value={id} type="number"
                              onChange={e => setVlans(vs => vs.map((v, j) => j === i ? [v[0], e.target.value] : v))}
                              placeholder="10"
                              className="w-24 text-xs font-mono border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary/50" />
                          </td>
                          <td className="px-2">
                            <button onClick={() => setVlans(vs => vs.filter((_, j) => j !== i))}
                              className="text-muted-foreground hover:text-destructive">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {vlans.length === 0 && (
                    <p className="text-xs text-muted-foreground px-3 py-3">No VLANs defined.</p>
                  )}
                </div>
                <button onClick={() => setVlans(vs => [...vs, ['', '']])}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <Plus className="h-3 w-3" /> Add VLAN
                </button>
              </div>
            )}

            {/* ── Port Map ── */}
            {tab === 'ports' && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Map each port to a VLAN and mode. Stored as <code className="font-mono bg-muted px-1 rounded">port_map</code> — iterate
                  with <code className="font-mono bg-muted px-1 rounded">{"{% for p in port_map %}"}</code> in your template.
                  Port naming (e.g. <code className="font-mono bg-muted px-1 rounded">GigabitEthernet1/0/{"{{ p.port }}"}</code>) is handled by the template.
                </p>

                {/* Generate controls */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground">Ports:</span>
                  {PORT_PRESETS.map(n => (
                    <button key={n} onClick={() => setPortCount(n)}
                      className={`text-xs px-2.5 py-1 rounded border transition-colors ${portCount === n ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-accent'}`}>
                      {n}
                    </button>
                  ))}
                  <input type="number" min={1} max={256} value={portCount}
                    onChange={e => setPortCount(Math.max(1, Math.min(256, Number(e.target.value))))}
                    className="w-16 text-xs border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary/50" />
                  <button onClick={generatePorts}
                    className="flex items-center gap-1 text-xs px-3 py-1 rounded bg-primary text-primary-foreground hover:opacity-90">
                    <RefreshCw className="h-3 w-3" />
                    {portMap.length > 0 ? 'Regenerate' : 'Generate'}
                  </button>
                  {portMap.length > 0 && (
                    <button onClick={() => setPortMap([])}
                      className="text-xs text-destructive hover:opacity-80">Clear</button>
                  )}
                </div>

                {portMap.length > 0 && (
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-muted/50 border-b">
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground w-12">Port</th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Description</th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground w-28">Mode</th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground w-28">VLAN</th>
                        </tr>
                      </thead>
                      <tbody>
                        {portMap.map((p, i) => (
                          <tr key={p.port} className={`border-b last:border-0 ${i % 2 === 0 ? '' : 'bg-muted/20'}`}>
                            <td className="px-3 py-1 font-mono text-muted-foreground">{p.port}</td>
                            <td className="px-3 py-1">
                              <input value={p.description}
                                onChange={e => updatePort(i, { description: e.target.value })}
                                placeholder="e.g. AP-01"
                                className="w-full border rounded px-2 py-0.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary/50" />
                            </td>
                            <td className="px-3 py-1">
                              <select value={p.mode} onChange={e => updatePort(i, { mode: e.target.value as PortMode })}
                                className="w-full border rounded px-2 py-0.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary/50">
                                {MODE_OPTS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                              </select>
                            </td>
                            <td className="px-3 py-1">
                              {vlans.length > 0 ? (
                                <select value={p.vlan} onChange={e => updatePort(i, { vlan: e.target.value })}
                                  className="w-full border rounded px-2 py-0.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary/50">
                                  <option value="">—</option>
                                  {vlans.filter(([n]) => n.trim()).map(([n, id]) => (
                                    <option key={n} value={n}>{n} ({id})</option>
                                  ))}
                                </select>
                              ) : (
                                <input value={p.vlan}
                                  onChange={e => updatePort(i, { vlan: e.target.value })}
                                  placeholder="VLAN name"
                                  className="w-full border rounded px-2 py-0.5 bg-background font-mono focus:outline-none focus:ring-1 focus:ring-primary/50" />
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {portMap.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground text-xs border rounded-lg border-dashed">
                    Choose a port count above and click Generate.
                  </div>
                )}
              </div>
            )}

            {/* ── Variables ── */}
            {tab === 'vars' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">Scalar variables passed to the template.</p>
                  <div className="flex items-center gap-2">
                    {templateId && (
                      <button onClick={discoverVars} disabled={discovering}
                        className="flex items-center gap-1 text-xs text-primary hover:opacity-80 disabled:opacity-50">
                        <Wand2 className="h-3 w-3" />
                        {discovering ? 'Discovering…' : 'Discover from template'}
                      </button>
                    )}
                    <button onClick={() => setVars(v => [...v, ['', '']])}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                      <Plus className="h-3 w-3" /> Add
                    </button>
                  </div>
                </div>
                <div className="space-y-2">
                  {vars.map(([k, v], i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <input value={k}
                        onChange={e => setVars(vs => vs.map((p, j) => j === i ? [e.target.value, p[1]] : p))}
                        placeholder="key"
                        className="w-32 shrink-0 text-xs border rounded px-2 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-primary/50" />
                      <textarea value={v}
                        onChange={e => {
                          const el = e.target; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'
                          setVars(vs => vs.map((p, j) => j === i ? [p[0], e.target.value] : p))
                        }}
                        onFocus={e => { const el = e.target; el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }}
                        placeholder="value" rows={1} spellCheck={false}
                        className="flex-1 text-xs border rounded px-2 py-1.5 font-mono resize-none overflow-hidden focus:outline-none focus:ring-1 focus:ring-primary/50" />
                      <button onClick={() => setVars(v => v.filter((_, j) => j !== i))}
                        className="mt-1.5 text-muted-foreground hover:text-destructive shrink-0">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  {vars.length === 0 && <p className="text-xs text-muted-foreground">No variables set.</p>}
                </div>
              </div>
            )}

            {error && <p className="text-xs text-destructive mt-3">{error}</p>}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t shrink-0 flex items-center justify-between">
            {initial ? (
              <button onClick={() => { if (confirm('Delete this profile?')) del.mutate() }}
                className="p-1.5 text-destructive hover:opacity-80 rounded hover:bg-destructive/10">
                <Trash2 className="h-4 w-4" />
              </button>
            ) : <div />}
            <button onClick={() => save.mutate()} disabled={save.isPending}
              className="text-sm px-4 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function ProfilesPage() {
  const [profileForm,      setProfileForm]      = useState<DeviceProfile | null | 'new'>(null)
  const [customerForm,     setCustomerForm]     = useState<Customer | null | 'new'>(null)
  const [selectedCustomer, setSelectedCustomer] = useState<string>('all')

  const { data: templates = [] } = useQuery<ConfigTemplate[]>({
    queryKey: ['templates'],
    queryFn:  () => api.get<ConfigTemplate[]>('/api/v1/templates'),
  })
  const { data: profiles = [], isLoading } = useQuery<DeviceProfile[]>({
    queryKey: ['profiles'],
    queryFn:  () => api.get<DeviceProfile[]>('/api/v1/profiles'),
  })
  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ['customers'],
    queryFn:  () => api.get<Customer[]>('/api/v1/customers'),
  })

  const visible = selectedCustomer === 'all'
    ? profiles
    : selectedCustomer === 'none'
      ? profiles.filter(p => !p.customer_id)
      : profiles.filter(p => p.customer_id === selectedCustomer)

  const editingCustomer = selectedCustomer !== 'all' && selectedCustomer !== 'none'
    ? customers.find(c => c.id === selectedCustomer)
    : undefined

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3">
            <Users className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold">Profiles</h1>
            {profiles.length > 0 && (
              <span className="text-sm text-muted-foreground">({visible.length})</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <div className="relative">
              <select value={selectedCustomer} onChange={e => setSelectedCustomer(e.target.value)}
                className="text-sm border rounded pl-3 pr-8 py-1.5 appearance-none bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 cursor-pointer">
                <option value="all">All customers</option>
                <option value="none">No customer</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
            <button onClick={() => setCustomerForm(editingCustomer ?? 'new')}
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded border hover:bg-accent">
              {editingCustomer ? 'Edit customer' : '+ Customer'}
            </button>
          </div>
        </div>
        <button onClick={() => setProfileForm('new')}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90">
          <Plus className="h-4 w-4" /> New Profile
        </button>
      </div>

      {isLoading && <div className="text-muted-foreground text-sm">Loading profiles…</div>}

      {!isLoading && visible.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <Users className="h-12 w-12 mx-auto mb-4 opacity-30" />
          <p className="font-medium">
            {selectedCustomer === 'all' ? 'No profiles yet' : 'No profiles for this customer'}
          </p>
          <p className="text-sm">Profiles group shared variables and link to a template.</p>
        </div>
      )}

      {visible.length > 0 && (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Template</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Target FW</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Ports</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">VLANs</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Description</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p, i) => {
                const tmpl     = templates.find(t => t.id === p.template_id)
                const customer = customers.find(c => c.id === p.customer_id)
                const portCount = Array.isArray(p.variables?.port_map) ? (p.variables.port_map as unknown[]).length : 0
                const vlanCount = p.variables?.vlans && typeof p.variables.vlans === 'object'
                  ? Object.keys(p.variables.vlans as object).length : 0
                return (
                  <tr key={p.id} onClick={() => setProfileForm(p)}
                    className={`cursor-pointer hover:bg-muted/40 transition-colors ${i % 2 === 0 ? '' : 'bg-muted/20'}`}>
                    <td className="px-4 py-3 font-medium">{p.name}</td>
                    <td className="px-4 py-3 text-xs">
                      {customer
                        ? <span className="inline-flex items-center gap-1 text-muted-foreground"><Building2 className="h-3 w-3" />{customer.name}</span>
                        : <span className="text-muted-foreground/40">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {tmpl
                        ? <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${VENDOR_COLORS[tmpl.vendor] ?? 'bg-gray-100 text-gray-700'}`}>{tmpl.name}</span>
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-muted-foreground">
                      {p.firmware_version ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {portCount > 0 ? `${portCount} ports` : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {vlanCount > 0 ? `${vlanCount} VLANs` : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{p.description ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {profileForm && (
        <ProfileForm
          initial={profileForm === 'new' ? undefined : profileForm}
          templates={templates}
          customers={customers}
          onClose={() => setProfileForm(null)}
        />
      )}
      {customerForm && (
        <CustomerForm
          initial={customerForm === 'new' ? undefined : customerForm}
          onClose={() => setCustomerForm(null)}
        />
      )}
    </div>
  )
}
