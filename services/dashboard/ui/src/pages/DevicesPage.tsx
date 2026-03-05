import { useQuery } from '@tanstack/react-query'
import { api, type Device } from '@/lib/api'
import { formatRelative } from '@/lib/utils'
import { Server, RefreshCw } from 'lucide-react'

const STATUS_COLORS: Record<Device['status'], string> = {
  unknown:      'bg-gray-100 text-gray-700',
  discovered:   'bg-blue-100 text-blue-700',
  provisioning: 'bg-yellow-100 text-yellow-700',
  provisioned:  'bg-green-100 text-green-700',
  failed:       'bg-red-100 text-red-700',
  ignored:      'bg-gray-100 text-gray-500',
}

export default function DevicesPage() {
  const { data: devices, isLoading, error, refetch, isFetching } = useQuery<Device[]>({
    queryKey: ['devices'],
    queryFn: () => api.get<Device[]>('/api/v1/devices'),
    refetchInterval: 30_000,
  })

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
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground
                     disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {isLoading && (
        <div className="text-muted-foreground text-sm">Loading devices…</div>
      )}

      {error && (
        <div className="text-destructive text-sm">Failed to load devices: {error.message}</div>
      )}

      {devices && devices.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <Server className="h-12 w-12 mx-auto mb-4 opacity-30" />
          <p className="font-medium">No devices yet</p>
          <p className="text-sm">Devices will appear here when they send DHCP requests.</p>
        </div>
      )}

      {devices && devices.length > 0 && (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Hostname</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">MAC</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Serial</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Vendor Class</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d, i) => (
                <tr key={d.id} className={i % 2 === 0 ? '' : 'bg-muted/20'}>
                  <td className="px-4 py-3 font-medium">{d.hostname ?? <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-4 py-3 font-mono text-xs">{d.mac ?? '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs">{d.serial ?? '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{d.vendor_class ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[d.status]}`}>
                      {d.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {d.last_seen ? formatRelative(d.last_seen) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
