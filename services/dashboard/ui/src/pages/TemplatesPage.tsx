import { useState, lazy, Suspense } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type ConfigTemplate } from '@/lib/api'
import { FileCode2, Plus, Trash2, X } from 'lucide-react'

const JinjaEditor = lazy(() => import('@/components/JinjaEditor'))

const VENDOR_COLORS: Record<string, string> = {
  cisco:    'bg-blue-100 text-blue-700',
  aruba:    'bg-orange-100 text-orange-700',
  juniper:  'bg-green-100 text-green-700',
  extreme:  'bg-purple-100 text-purple-700',
  fortinet: 'bg-red-100 text-red-700',
}

// ── Template Form ──────────────────────────────────────────────────────────────

function TemplateForm({ initial, onClose }: { initial?: ConfigTemplate; onClose: () => void }) {
  const qc = useQueryClient()
  const [name,     setName]     = useState(initial?.name ?? '')
  const [vendor,   setVendor]   = useState(initial?.vendor ?? 'cisco')
  const [osType,   setOsType]   = useState(initial?.os_type ?? '')
  const [filePath, setFilePath] = useState(initial?.file_path ?? '')
  const [content,  setContent]  = useState(initial?.content ?? '')
  const [error,    setError]    = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name, vendor,
        os_type:   osType,
        file_path: filePath || undefined,
        content:   content.trim() || undefined,
      }
      return initial
        ? api.put<ConfigTemplate>(`/api/v1/templates/${initial.id}`, { ...initial, ...body })
        : api.post<ConfigTemplate>('/api/v1/templates', body)
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates'] }); onClose() },
    onError: (e: Error) => setError(e.message),
  })

  const del = useMutation({
    mutationFn: () => api.delete(`/api/v1/templates/${initial!.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates'] }); onClose() },
    onError: (e: Error) => setError(e.message),
  })

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-background border rounded-lg shadow-xl w-full max-w-4xl flex flex-col max-h-[90vh]">
          <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
            <p className="font-semibold text-sm">{initial ? 'Edit Template' : 'New Template'}</p>
            <button onClick={onClose}><X className="h-4 w-4" /></button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Name</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Juniper EX Baseline"
                  className="w-full text-sm border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Vendor</label>
                <select value={vendor} onChange={e => setVendor(e.target.value)}
                  className="w-full text-sm border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50">
                  {['cisco','aruba','juniper','extreme','fortinet'].map(v => (
                    <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">OS Type</label>
                <input value={osType} onChange={e => setOsType(e.target.value)} placeholder="junos-ex"
                  className="w-full text-sm border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/50" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                File Path <span className="font-normal">(fallback when content is empty)</span>
              </label>
              <input value={filePath} onChange={e => setFilePath(e.target.value)} placeholder="juniper/junos-ex.cfg"
                className="w-full text-sm border rounded px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-muted-foreground">
                  Template Content <span className="font-normal">(Jinja2 — overrides file when set)</span>
                </label>
                {content.trim() && (
                  <button onClick={() => setContent('')}
                    className="text-xs text-muted-foreground hover:text-destructive">
                    Clear (revert to file)
                  </button>
                )}
              </div>
              <Suspense fallback={
                <textarea
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  spellCheck={false}
                  className="w-full h-96 text-xs font-mono border rounded px-3 py-2 bg-muted/30 resize-y focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              }>
                <JinjaEditor
                  value={content}
                  onChange={setContent}
                  placeholder={'# Paste or write your Jinja2 template here.\n# Leave empty to use the file path above.'}
                />
              </Suspense>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="px-5 py-4 border-t shrink-0 flex items-center justify-between">
            {initial ? (
              <button onClick={() => { if (confirm('Delete this template?')) del.mutate() }}
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

export default function TemplatesPage() {
  const [templateForm, setTemplateForm] = useState<ConfigTemplate | null | 'new'>(null)

  const { data: templates = [], isLoading } = useQuery<ConfigTemplate[]>({
    queryKey: ['templates'],
    queryFn:  () => api.get<ConfigTemplate[]>('/api/v1/templates'),
  })

  const grouped = templates.reduce((acc, t) => {
    if (!acc[t.vendor]) acc[t.vendor] = []
    acc[t.vendor].push(t)
    return acc
  }, {} as Record<string, ConfigTemplate[]>)

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <FileCode2 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Config Templates</h1>
        </div>
        <button onClick={() => setTemplateForm('new')}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded bg-primary text-primary-foreground hover:opacity-90">
          <Plus className="h-4 w-4" /> New Template
        </button>
      </div>

      {isLoading && <div className="text-muted-foreground text-sm">Loading templates…</div>}

      {!isLoading && templates.length === 0 && (
        <div className="text-center py-10 text-muted-foreground text-sm border rounded-lg">
          No templates yet. Click "New Template" to create one.
        </div>
      )}

      {Object.entries(grouped).map(([vendor, items]) => (
        <div key={vendor} className="mb-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3 capitalize">
            {vendor}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map(t => (
              <div key={t.id} onClick={() => setTemplateForm(t)}
                className="border rounded-lg p-4 bg-card hover:shadow-sm transition-shadow cursor-pointer">
                <div className="flex items-start justify-between mb-2">
                  <p className="font-medium text-sm">{t.name}</p>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${VENDOR_COLORS[t.vendor] ?? 'bg-gray-100 text-gray-700'}`}>
                    {t.os_type}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground font-mono">
                  {t.content ? '● DB' : t.file_path ?? '—'}
                </p>
              </div>
            ))}
          </div>
        </div>
      ))}

      {templateForm && (
        <TemplateForm
          initial={templateForm === 'new' ? undefined : templateForm}
          onClose={() => setTemplateForm(null)}
        />
      )}
    </div>
  )
}
