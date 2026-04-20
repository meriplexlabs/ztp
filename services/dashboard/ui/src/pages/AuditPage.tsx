import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/utils'
import { ClipboardList, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react'

interface AuditEntry {
  id: number
  user_id?: string
  username?: string
  action: string
  entity_type?: string
  entity_id?: string
  payload: Record<string, unknown>
  ip_address?: string
  created_at: string
}

const ACTION_COLORS: Record<string, string> = {
  created:      'bg-green-100 text-green-700',
  updated:      'bg-blue-100 text-blue-700',
  deleted:      'bg-red-100 text-red-700',
  login:        'bg-purple-100 text-purple-700',
  logout:       'bg-gray-100 text-gray-600',
  config_pushed:'bg-orange-100 text-orange-700',
  config_fetched:'bg-yellow-100 text-yellow-700',
}

const PAGE_SIZE = 50

export default function AuditPage() {
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<number | null>(null)

  const { data: entries = [], isLoading, error, refetch, isFetching } = useQuery<AuditEntry[]>({
    queryKey: ['audit', page],
    queryFn: () => api.get<AuditEntry[]>(`/api/v1/audit?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`),
  })

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ClipboardList className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Audit Log</h1>
          {entries.length > 0 && (
            <span className="text-sm text-muted-foreground">({entries.length} on this page)</span>
          )}
        </div>
        <button onClick={() => refetch()} disabled={isFetching}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors">
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {isLoading && <div className="text-muted-foreground text-sm">Loading…</div>}
      {error && <div className="text-destructive text-sm">Failed to load audit log.</div>}

      {!isLoading && entries.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <ClipboardList className="h-12 w-12 mx-auto mb-4 opacity-30" />
          <p className="font-medium">No audit entries yet</p>
          <p className="text-sm">Actions like creating devices, pushing configs, and logins will appear here.</p>
        </div>
      )}

      {entries.length > 0 && (
        <>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground w-36">When</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground w-28">Action</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Entity</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground w-32">User</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground w-32">IP</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => {
                  const isExpanded = expanded === e.id
                  const payload = e.payload ?? {}
                  const payloadKeys = Object.keys(payload).filter(k => payload[k] != null)
                  return (
                    <tr
                      key={e.id}
                      onClick={() => setExpanded(isExpanded ? null : e.id)}
                      className={`cursor-pointer hover:bg-muted/40 transition-colors border-b last:border-0 ${i % 2 === 0 ? '' : 'bg-muted/20'}`}
                    >
                      <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                        {formatRelative(e.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${ACTION_COLORS[e.action] ?? 'bg-gray-100 text-gray-600'}`}>
                          {e.action.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {e.entity_type && (
                          <span className="text-muted-foreground capitalize">{e.entity_type}</span>
                        )}
                        {e.entity_id && (
                          <span className="font-mono text-muted-foreground/60 ml-1.5">
                            {e.entity_id.slice(0, 8)}…
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs font-medium">
                        {e.username ?? <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-3 text-xs font-mono text-muted-foreground">
                        {e.ip_address ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {isExpanded ? (
                          <pre className="whitespace-pre-wrap font-mono text-xs bg-muted/50 rounded p-2 max-w-xs">
                            {JSON.stringify(payload, null, 2)}
                          </pre>
                        ) : (
                          payloadKeys.length > 0
                            ? payloadKeys.slice(0, 3).map(k => (
                                <span key={k} className="mr-3">
                                  <span className="text-muted-foreground/60">{k}:</span>{' '}
                                  <span>{String(payload[k])}</span>
                                </span>
                              ))
                            : '—'
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" /> Previous
            </button>
            <span className="text-xs text-muted-foreground">Page {page + 1}</span>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={entries.length < PAGE_SIZE}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </>
      )}
    </div>
  )
}
