import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type ConfigTemplate, type DeviceProfile, type Customer } from '@/lib/api'
import { Users, Plus, Trash2, X, Wand2, Building2, ChevronDown } from 'lucide-react'

const VENDOR_COLORS: Record<string, string> = {
  cisco:    'bg-blue-100 text-blue-700',
  aruba:    'bg-orange-100 text-orange-700',
  juniper:  'bg-green-100 text-green-700',
  extreme:  'bg-purple-100 text-purple-700',
  fortinet: 'bg-red-100 text-red-700',
}

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

function ProfileForm({
  initial, templates, customers, onClose,
}: {
  initial?: DeviceProfile
  templates: ConfigTemplate[]
  customers: Customer[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name,       setName]       = useState(initial?.name ?? '')
  const [desc,       setDesc]       = useState(initial?.description ?? '')
  const [customerId, setCustomerId] = useState(initial?.customer_id ?? '')
  const [templateId, setTemplateId] = useState(initial?.template_id ?? '')
  const [vars, setVars] = useState<[string, string][]>(
    Object.entries(initial?.variables ?? {}).map(([k, v]) => [k, String(v)])
  )
  const [error,       setError]       = useState<string | null>(null)
  const [discovering, setDiscovering] = useState(false)

  const save = useMutation({
    mutationFn: () => {
      const variables = Object.fromEntries(vars.filter(([k]) => k.trim() !== ''))
      const body = {
        name,
        description: desc || undefined,
        customer_id: customerId || undefined,
        template_id: templateId || undefined,
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

  function addVar()             { setVars(v => [...v, ['', '']]) }
  function removeVar(i: number) { setVars(v => v.filter((_, j) => j !== i)) }

  async function discoverVars() {
    if (!templateId) return
    setDiscovering(true)
    setError(null)
    try {
      const result = await api.get<{ variables: string[] }>(`/api/v1/templates/${templateId}/variables`)
      setVars(current => {
        const existing = new Set(current.map(([k]) => k))
        const newVars = result.variables
          .filter(v => !existing.has(v))
          .map((v): [string, string] => [v, ''])
        return [...current, ...newVars]
      })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to discover variables')
    } finally {
      setDiscovering(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-background border rounded-lg shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]">
          <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
            <p className="font-semibold text-sm">{initial ? 'Edit Profile' : 'New Profile'}</p>
            <button onClick={onClose}><X className="h-4 w-4" /></button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Name</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Juniper EX Standard"
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
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-muted-foreground">Default Variables</label>
                <div className="flex items-center gap-2">
                  {templateId && (
                    <button onClick={discoverVars} disabled={discovering}
                      className="flex items-center gap-1 text-xs text-primary hover:opacity-80 disabled:opacity-50">
                      <Wand2 className="h-3 w-3" />
                      {discovering ? 'Discovering…' : 'Discover from template'}
                    </button>
                  )}
                  <button onClick={addVar} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                    <Plus className="h-3 w-3" /> Add
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                {vars.map(([k, v], i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input value={k} onChange={e => setVars(vs => vs.map((p, j) => j === i ? [e.target.value, p[1]] : p))}
                      placeholder="key"
                      className="flex-1 text-xs border rounded px-2 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-primary/50" />
                    <input value={v} onChange={e => setVars(vs => vs.map((p, j) => j === i ? [p[0], e.target.value] : p))}
                      placeholder="value"
                      className="flex-1 text-xs border rounded px-2 py-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-primary/50" />
                    <button onClick={() => removeVar(i)} className="text-muted-foreground hover:text-destructive">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                {vars.length === 0 && <p className="text-xs text-muted-foreground">No variables set</p>}
              </div>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="px-5 py-4 border-t shrink-0 flex items-center justify-between">
            {initial ? (
              <button onClick={() => { if (confirm('Delete this profile?')) del.mutate() }}
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

          {/* Customer filter */}
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <div className="relative">
              <select
                value={selectedCustomer}
                onChange={e => setSelectedCustomer(e.target.value)}
                className="text-sm border rounded pl-3 pr-8 py-1.5 appearance-none bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 cursor-pointer"
              >
                <option value="all">All customers</option>
                <option value="none">No customer</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
            <button
              onClick={() => setCustomerForm(editingCustomer ?? 'new')}
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded border hover:bg-accent"
            >
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
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Variables</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Description</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p, i) => {
                const tmpl     = templates.find(t => t.id === p.template_id)
                const customer = customers.find(c => c.id === p.customer_id)
                const varCount = Object.keys(p.variables ?? {}).length
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
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {varCount > 0 ? `${varCount} variable${varCount !== 1 ? 's' : ''}` : '—'}
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
