import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Settings, Save, RotateCcw, KeyRound, Check, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Setting {
  key: string
  value: string | null
  label: string
  description?: string
  category: string
  effective_value: string
  source: 'db' | 'env' | 'default'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  ztp:     'ZTP',
  dhcp:    'DHCP / Kea',
  snmp:    'SNMP Defaults',
  general: 'General',
}

function SourceBadge({ source }: { source: Setting['source'] }) {
  if (source === 'db')  return <span className="text-xs text-green-600 font-medium">saved</span>
  if (source === 'env') return <span className="text-xs text-blue-500">from env</span>
  return <span className="text-xs text-muted-foreground">default</span>
}

// ─── Setting Row ──────────────────────────────────────────────────────────────

function SettingRow({
  setting,
  canEdit,
  onSave,
  onClear,
}: {
  setting: Setting
  canEdit: boolean
  onSave: (key: string, value: string) => void
  onClear: (key: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(setting.effective_value)

  const handleSave = () => { onSave(setting.key, draft); setEditing(false) }
  const handleCancel = () => { setDraft(setting.effective_value); setEditing(false) }

  return (
    <div className="flex items-start gap-4 py-3 border-b last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium">{setting.label}</span>
          <SourceBadge source={setting.source} />
        </div>
        {setting.description && (
          <p className="text-xs text-muted-foreground">{setting.description}</p>
        )}
        <p className="text-xs text-muted-foreground/60 font-mono mt-0.5">{setting.key}</p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {editing ? (
          <>
            <input
              autoFocus
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') handleCancel() }}
              className="w-56 rounded border border-input bg-background px-2 py-1 text-sm
                         focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button onClick={handleSave} className="p-1 rounded hover:bg-accent text-green-600" title="Save">
              <Check className="h-4 w-4" />
            </button>
            <button onClick={handleCancel} className="p-1 rounded hover:bg-accent text-muted-foreground" title="Cancel">
              <X className="h-4 w-4" />
            </button>
          </>
        ) : (
          <>
            <span className={cn(
              'font-mono text-sm px-2 py-1 rounded bg-muted min-w-32 text-right',
              !setting.effective_value && 'text-muted-foreground italic',
            )}>
              {setting.effective_value || 'not set'}
            </span>
            {canEdit && (
              <>
                <button
                  onClick={() => { setDraft(setting.effective_value); setEditing(true) }}
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                  title="Edit"
                >
                  <Save className="h-3.5 w-3.5" />
                </button>
                {setting.source === 'db' && (
                  <button
                    onClick={() => onClear(setting.key)}
                    className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                    title="Revert to env/default"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Password Change ──────────────────────────────────────────────────────────

function PasswordSection() {
  const [current, setCurrent] = useState('')
  const [next, setNext]       = useState('')
  const [confirm, setConfirm] = useState('')
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  const mutation = useMutation({
    mutationFn: () => api.put('/api/v1/users/me/password', {
      current_password: current,
      new_password: next,
    }),
    onSuccess: () => {
      setFeedback({ ok: true, msg: 'Password updated.' })
      setCurrent(''); setNext(''); setConfirm('')
    },
    onError: (err: Error) => setFeedback({ ok: false, msg: err.message }),
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setFeedback(null)
    if (next !== confirm) { setFeedback({ ok: false, msg: 'Passwords do not match.' }); return }
    mutation.mutate()
  }

  return (
    <section className="border rounded-lg p-5 bg-card">
      <div className="flex items-center gap-2 mb-4">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-semibold">Change Password</h2>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3 max-w-sm">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Current password</label>
          <input type="password" value={current} onChange={e => setCurrent(e.target.value)} required
            className="w-full rounded border border-input bg-background px-3 py-1.5 text-sm
                       focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">New password</label>
          <input type="password" value={next} onChange={e => setNext(e.target.value)} required minLength={8}
            className="w-full rounded border border-input bg-background px-3 py-1.5 text-sm
                       focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Confirm new password</label>
          <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required
            className="w-full rounded border border-input bg-background px-3 py-1.5 text-sm
                       focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        {feedback && (
          <p className={cn('text-sm', feedback.ok ? 'text-green-600' : 'text-destructive')}>
            {feedback.msg}
          </p>
        )}
        <button type="submit" disabled={mutation.isPending}
          className="rounded bg-primary text-primary-foreground px-4 py-1.5 text-sm font-medium
                     hover:bg-primary/90 disabled:opacity-50 transition-colors">
          {mutation.isPending ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </section>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const queryClient = useQueryClient()

  const { data: settings, isLoading, error } = useQuery<Setting[]>({
    queryKey: ['settings'],
    queryFn: () => api.get<Setting[]>('/api/v1/settings'),
  })

  const saveMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      api.put(`/api/v1/settings/${key}`, { value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  })

  const clearMutation = useMutation({
    mutationFn: (key: string) => api.put(`/api/v1/settings/${key}`, { value: null }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  })

  const grouped = settings?.reduce((acc, s) => {
    if (!acc[s.category]) acc[s.category] = []
    acc[s.category].push(s)
    return acc
  }, {} as Record<string, Setting[]>)

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-3 mb-6">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>

      <div className="space-y-6">
        <PasswordSection />

        {isLoading && <p className="text-sm text-muted-foreground">Loading settings…</p>}
        {error && <p className="text-sm text-destructive">Failed to load settings.</p>}

        {grouped && Object.entries(grouped).map(([cat, items]) => (
          <section key={cat} className="border rounded-lg bg-card">
            <div className="px-5 py-3 border-b">
              <h2 className="font-semibold text-sm">{CATEGORY_LABELS[cat] ?? cat}</h2>
              {!isAdmin && (
                <p className="text-xs text-muted-foreground mt-0.5">Admin role required to edit.</p>
              )}
            </div>
            <div className="px-5">
              {items.map(s => (
                <SettingRow
                  key={s.key}
                  setting={s}
                  canEdit={isAdmin}
                  onSave={(key, value) => saveMutation.mutate({ key, value })}
                  onClear={key => clearMutation.mutate(key)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
