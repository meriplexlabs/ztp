import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/utils'
import { Bell, CheckCheck, RefreshCw, ShieldAlert } from 'lucide-react'

interface Alert {
  id: number
  type: string
  severity: string
  device_id?: string
  message: string
  resolved: boolean
  resolved_at?: string
  created_at: string
}

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'border-l-red-500 bg-red-50',
  warning:  'border-l-amber-400 bg-amber-50',
  info:     'border-l-blue-400 bg-blue-50',
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  warning:  'bg-amber-100 text-amber-700',
  info:     'bg-blue-100 text-blue-700',
}

const TYPE_LABEL: Record<string, string> = {
  failed:        'Device Failed',
  firmware_drift:'Firmware Drift',
  offline:       'Device Offline',
}

export default function AlertsPage() {
  const qc = useQueryClient()
  const [showResolved, setShowResolved] = useState(false)

  const { data: alerts = [], isLoading, refetch, isFetching } = useQuery<Alert[]>({
    queryKey: ['alerts', showResolved],
    queryFn: () => api.get<Alert[]>(`/api/v1/alerts${showResolved ? '?all=true' : ''}`),
    refetchInterval: 30_000,
  })

  const resolve = useMutation({
    mutationFn: (id: number) => api.post(`/api/v1/alerts/${id}/resolve`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] })
      qc.invalidateQueries({ queryKey: ['alert-count'] })
    },
  })

  const resolveAll = useMutation({
    mutationFn: async () => {
      const unresolved = alerts.filter(a => !a.resolved)
      await Promise.all(unresolved.map(a => api.post(`/api/v1/alerts/${a.id}/resolve`, {})))
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] })
      qc.invalidateQueries({ queryKey: ['alert-count'] })
    },
  })

  const unresolved = alerts.filter(a => !a.resolved)

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Bell className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Alerts</h1>
          {unresolved.length > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
              {unresolved.length} active
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
            <input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)}
              className="rounded" />
            Show resolved
          </label>
          {unresolved.length > 1 && (
            <button onClick={() => resolveAll.mutate()} disabled={resolveAll.isPending}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded border hover:bg-accent disabled:opacity-50">
              <CheckCheck className="h-4 w-4" /> Resolve all
            </button>
          )}
          <button onClick={() => refetch()} disabled={isFetching}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {isLoading && <div className="text-muted-foreground text-sm">Loading…</div>}

      {!isLoading && alerts.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <ShieldAlert className="h-12 w-12 mx-auto mb-4 opacity-30" />
          <p className="font-medium text-green-600">All clear</p>
          <p className="text-sm">No active alerts. The poller checks every minute.</p>
        </div>
      )}

      <div className="space-y-2">
        {alerts.map(a => (
          <div key={a.id}
            className={`border-l-4 rounded-lg p-4 border border-l-4 flex items-start justify-between gap-4 ${
              a.resolved ? 'border-l-gray-300 bg-gray-50 opacity-60' : (SEVERITY_STYLE[a.severity] ?? 'border-l-gray-400 bg-gray-50')
            }`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${SEVERITY_BADGE[a.severity] ?? 'bg-gray-100 text-gray-600'}`}>
                  {a.severity}
                </span>
                <span className="text-xs font-semibold text-foreground">
                  {TYPE_LABEL[a.type] ?? a.type.replace(/_/g, ' ')}
                </span>
                {a.resolved && (
                  <span className="text-xs text-muted-foreground">· resolved {a.resolved_at ? formatRelative(a.resolved_at) : ''}</span>
                )}
              </div>
              <p className="text-sm">{a.message}</p>
              <p className="text-xs text-muted-foreground mt-1">{formatRelative(a.created_at)}</p>
            </div>
            {!a.resolved && (
              <button
                onClick={() => resolve.mutate(a.id)}
                disabled={resolve.isPending}
                className="shrink-0 text-xs px-2.5 py-1 rounded border hover:bg-background disabled:opacity-50"
              >
                Resolve
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
