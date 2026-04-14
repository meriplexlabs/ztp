import { useQuery } from '@tanstack/react-query'
import { api, type DHCPLease } from '@/lib/api'
import { Network, RefreshCw } from 'lucide-react'

const LEASE_STATES: Record<number, string> = {
  0: 'active',
  1: 'declined',
  2: 'expired',
}

export default function LeasesPage() {
  const { data, isLoading, error, refetch, isFetching } = useQuery<DHCPLease[]>({
    queryKey: ['leases'],
    queryFn: () => api.get<DHCPLease[]>('/api/v1/leases'),
    refetchInterval: 30_000,
  })

  const leases = data ?? []

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Network className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">DHCP Leases</h1>
          <span className="text-sm text-muted-foreground">({leases.length})</span>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {isLoading && <div className="text-muted-foreground text-sm">Loading leases…</div>}
      {error && (
        <div className="text-sm text-destructive bg-red-50 border border-red-200 rounded p-3">
          Failed to load leases: {error.message}
        </div>
      )}

      {!isLoading && leases.length === 0 && !error && (
        <div className="text-center py-16 text-muted-foreground">
          <Network className="h-12 w-12 mx-auto mb-4 opacity-30" />
          <p className="font-medium">No active leases</p>
        </div>
      )}

      {leases.length > 0 && (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">IP Address</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">MAC</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Hostname</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Subnet</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">State</th>
              </tr>
            </thead>
            <tbody>
              {leases.map((l, i) => (
                <tr key={l.ip_address} className={i % 2 === 0 ? '' : 'bg-muted/20'}>
                  <td className="px-4 py-3 font-mono">{l.ip_address}</td>
                  <td className="px-4 py-3 font-mono text-xs">{l.hw_address || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{l.hostname || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{l.subnet_id}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      l.state === 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                    }`}>
                      {LEASE_STATES[l.state] ?? `state-${l.state}`}
                    </span>
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
