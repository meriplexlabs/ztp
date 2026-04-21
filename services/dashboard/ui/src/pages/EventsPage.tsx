import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type SyslogEvent, type Device, SEVERITY_LABELS } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { ScrollText, RefreshCw } from 'lucide-react'

const SEVERITY_COLORS: Record<number, string> = {
  0: 'bg-red-600 text-white',
  1: 'bg-red-500 text-white',
  2: 'bg-red-400 text-white',
  3: 'bg-orange-400 text-white',
  4: 'bg-yellow-400 text-white',
  5: 'bg-blue-400 text-white',
  6: 'bg-green-500 text-white',
  7: 'bg-gray-400 text-white',
}

export default function EventsPage() {
  const [deviceID, setSourceIP] = useState('')

  const { data: devices } = useQuery<Device[]>({
    queryKey: ['devices'],
    queryFn: () => api.get<Device[]>('/api/v1/devices'),
  })

  const params = new URLSearchParams({ limit: '200' })
  if (deviceID) params.set('device_id', deviceID)

  const { data: events, isLoading, error, refetch, isFetching } = useQuery<SyslogEvent[]>({
    queryKey: ['events', deviceID],
    queryFn: () => api.get<SyslogEvent[]>(`/api/v1/events?${params}`),
    refetchInterval: 15_000,
  })

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ScrollText className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Syslog Events</h1>
          {events && <span className="text-sm text-muted-foreground">({events.length})</span>}
        </div>
        <div className="flex items-center gap-3">
          <select
            value={deviceID}
            onChange={e => setSourceIP(e.target.value)}
            className="text-sm border rounded px-2 py-1 bg-background"
          >
            <option value="">All devices</option>
            {devices?.map(d => (
              <option key={d.id} value={d.id}>
                {d.hostname ?? d.serial ?? d.mac ?? d.id.slice(0, 8)}
              </option>
            ))}
          </select>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {isLoading && <div className="text-muted-foreground text-sm">Loading events…</div>}
      {error && <div className="text-destructive text-sm">Failed to load events</div>}

      {events && events.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <ScrollText className="h-12 w-12 mx-auto mb-4 opacity-30" />
          <p className="font-medium">No events yet</p>
          <p className="text-sm">Syslog messages from devices will appear here.</p>
        </div>
      )}

      {events && events.length > 0 && (
        <div className="space-y-1">
          {events.map(e => (
            <div key={e.id} className="flex items-start gap-3 text-sm py-2 border-b last:border-0">
              <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded font-medium ${SEVERITY_COLORS[e.severity] ?? 'bg-gray-100 text-gray-700'}`}>
                {SEVERITY_LABELS[e.severity] ?? e.severity}
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground w-36">
                {e.source_ip}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground w-44">
                {formatDate(e.received_at)}
              </span>
              <span className="flex-1 font-mono text-xs break-all">{e.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
