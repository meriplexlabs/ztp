import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api, type Device, type DeviceProfile, type SyslogEvent, type DHCPLease } from '@/lib/api'
import { formatRelative } from '@/lib/utils'
import {
  Server, AlertTriangle, CheckCircle2, Loader2, XCircle,
  Activity, Wifi, GitCompare, Cpu, ScrollText, ArrowRight,
} from 'lucide-react'

const STATUS_COLORS: Record<Device['status'], string> = {
  unknown:      'bg-gray-100 text-gray-600',
  discovered:   'bg-blue-100 text-blue-700',
  provisioning: 'bg-yellow-100 text-yellow-700',
  provisioned:  'bg-green-100 text-green-700',
  failed:       'bg-red-100 text-red-700',
  ignored:      'bg-gray-100 text-gray-400',
}

function StatCard({
  label, value, sub, icon: Icon, accent, onClick,
}: {
  label: string
  value: number | string
  sub?: string
  icon: React.ElementType
  accent?: string
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left w-full p-5 rounded-xl border bg-card shadow-sm transition-all hover:shadow-md ${onClick ? 'cursor-pointer hover:border-primary/40' : 'cursor-default'}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
          <p className={`text-3xl font-bold tracking-tight ${accent ?? ''}`}>{value}</p>
          {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
        </div>
        <div className={`p-2 rounded-lg ${accent ? 'bg-current/10' : 'bg-muted'}`}>
          <Icon className={`h-5 w-5 ${accent ?? 'text-muted-foreground'}`} />
        </div>
      </div>
    </button>
  )
}

function DeviceStatusBar({ devices }: { devices: Device[] }) {
  const counts = devices.reduce((acc, d) => {
    acc[d.status] = (acc[d.status] ?? 0) + 1
    return acc
  }, {} as Record<string, number>)
  const total = devices.length
  if (total === 0) return null

  const segments: { status: Device['status']; color: string }[] = [
    { status: 'provisioned',  color: 'bg-green-500'  },
    { status: 'provisioning', color: 'bg-yellow-400' },
    { status: 'discovered',   color: 'bg-blue-400'   },
    { status: 'failed',       color: 'bg-red-500'    },
    { status: 'unknown',      color: 'bg-gray-300'   },
    { status: 'ignored',      color: 'bg-gray-200'   },
  ]

  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden gap-px">
        {segments.map(({ status, color }) => {
          const count = counts[status] ?? 0
          if (count === 0) return null
          return (
            <div
              key={status}
              className={`${color} transition-all`}
              style={{ width: `${(count / total) * 100}%` }}
              title={`${status}: ${count}`}
            />
          )
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {segments.map(({ status, color }) => {
          const count = counts[status] ?? 0
          if (count === 0) return null
          return (
            <span key={status} className="flex items-center gap-1.5 text-xs text-muted-foreground capitalize">
              <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
              {status} <span className="font-medium text-foreground">{count}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const navigate = useNavigate()

  const { data: devices = [] } = useQuery<Device[]>({
    queryKey: ['devices'],
    queryFn:  () => api.get<Device[]>('/api/v1/devices'),
    refetchInterval: 30_000,
  })
  const { data: profiles = [] } = useQuery<DeviceProfile[]>({
    queryKey: ['profiles'],
    queryFn:  () => api.get<DeviceProfile[]>('/api/v1/profiles'),
  })
  const { data: events = [] } = useQuery<SyslogEvent[]>({
    queryKey: ['events-recent'],
    queryFn:  () => api.get<SyslogEvent[]>('/api/v1/events?limit=50&offset=0'),
    refetchInterval: 30_000,
  })
  const { data: leases = [] } = useQuery<DHCPLease[]>({
    queryKey: ['leases'],
    queryFn:  () => api.get<DHCPLease[]>('/api/v1/leases'),
    refetchInterval: 30_000,
  })

  // Derived stats
  const provisioned  = devices.filter(d => d.status === 'provisioned').length
  const failed       = devices.filter(d => d.status === 'failed').length
  const provisioning = devices.filter(d => d.status === 'provisioning').length

  // Firmware drift: devices with a firmware_version whose profile has a target that differs
  const firmwareDrift = devices.filter(d => {
    if (!d.firmware_version || !d.profile_id) return false
    const profile = profiles.find(p => p.id === d.profile_id)
    return profile?.firmware_version && profile.firmware_version !== d.firmware_version
  })

  // Config drift would require fetching per-device — just show devices with profiles as "checkable"
  const withProfiles = devices.filter(d => d.profile_id)

  // Recent failed devices
  const failedDevices = devices.filter(d => d.status === 'failed')

  // Recent syslog events (last 10, severity <= 4 = warning or worse)
  const recentAlerts = events
    .filter(e => e.severity <= 4)
    .slice(0, 8)

  const SEVERITY_LABEL: Record<number, { label: string; color: string }> = {
    0: { label: 'EMERG',  color: 'text-red-700'    },
    1: { label: 'ALERT',  color: 'text-red-600'    },
    2: { label: 'CRIT',   color: 'text-red-500'    },
    3: { label: 'ERR',    color: 'text-orange-600' },
    4: { label: 'WARN',   color: 'text-yellow-600' },
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
        <p className="text-sm text-muted-foreground mt-1">Network provisioning status at a glance</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total Devices"
          value={devices.length}
          sub={`${leases.length} active leases`}
          icon={Server}
          onClick={() => navigate('/devices')}
        />
        <StatCard
          label="Provisioned"
          value={provisioned}
          sub={devices.length > 0 ? `${Math.round((provisioned / devices.length) * 100)}% of fleet` : undefined}
          icon={CheckCircle2}
          accent="text-green-600"
          onClick={() => navigate('/devices')}
        />
        <StatCard
          label="Failed"
          value={failed}
          sub={provisioning > 0 ? `${provisioning} provisioning` : 'none in progress'}
          icon={failed > 0 ? XCircle : CheckCircle2}
          accent={failed > 0 ? 'text-red-600' : 'text-green-600'}
          onClick={() => navigate('/devices')}
        />
        <StatCard
          label="Firmware Drift"
          value={firmwareDrift.length}
          sub={`${withProfiles.length} devices with profiles`}
          icon={Cpu}
          accent={firmwareDrift.length > 0 ? 'text-amber-600' : undefined}
          onClick={() => navigate('/devices')}
        />
      </div>

      {/* Device status bar */}
      {devices.length > 0 && (
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold">Device Status</h2>
            <button onClick={() => navigate('/devices')}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
              View all <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          <DeviceStatusBar devices={devices} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Failed devices */}
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" />
              <h2 className="text-sm font-semibold">Failed Devices</h2>
              {failedDevices.length > 0 && (
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                  {failedDevices.length}
                </span>
              )}
            </div>
            <button onClick={() => navigate('/devices')}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
              View all <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          {failedDevices.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-green-600 py-2">
              <CheckCircle2 className="h-4 w-4" /> No failed devices
            </div>
          ) : (
            <div className="space-y-2">
              {failedDevices.slice(0, 6).map(d => (
                <div key={d.id} className="flex items-center justify-between py-1.5 border-b last:border-0">
                  <div>
                    <p className="text-sm font-medium">{d.hostname ?? d.serial ?? d.mac ?? d.id.slice(0, 8)}</p>
                    <p className="text-xs text-muted-foreground">{d.description ?? d.vendor_class ?? '—'}</p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {d.last_seen ? formatRelative(d.last_seen) : '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Firmware drift */}
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-amber-500" />
              <h2 className="text-sm font-semibold">Firmware Drift</h2>
              {firmwareDrift.length > 0 && (
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                  {firmwareDrift.length}
                </span>
              )}
            </div>
            <button onClick={() => navigate('/devices')}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
              View all <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          {firmwareDrift.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-green-600 py-2">
              <CheckCircle2 className="h-4 w-4" /> All devices on target firmware
            </div>
          ) : (
            <div className="space-y-2">
              {firmwareDrift.slice(0, 6).map(d => {
                const profile = profiles.find(p => p.id === d.profile_id)
                return (
                  <div key={d.id} className="flex items-center justify-between py-1.5 border-b last:border-0">
                    <div>
                      <p className="text-sm font-medium">{d.hostname ?? d.serial ?? d.id.slice(0, 8)}</p>
                      <p className="text-xs font-mono text-muted-foreground">
                        {d.firmware_version}
                        <span className="mx-1.5 text-muted-foreground/40">→</span>
                        <span className="text-amber-600">{profile?.firmware_version}</span>
                      </p>
                    </div>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">update</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Provisioning activity */}
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 text-blue-500" />
              <h2 className="text-sm font-semibold">Recently Provisioned</h2>
            </div>
            <button onClick={() => navigate('/devices')}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
              View all <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          {(() => {
            const recent = devices
              .filter(d => d.provisioned_at)
              .sort((a, b) => new Date(b.provisioned_at!).getTime() - new Date(a.provisioned_at!).getTime())
              .slice(0, 6)
            return recent.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No provisioned devices yet.</p>
            ) : (
              <div className="space-y-2">
                {recent.map(d => {
                  const lease = leases.find(l =>
                    (d.hostname && l.hostname === d.hostname) || (d.mac && l.hw_address === d.mac)
                  )
                  return (
                    <div key={d.id} className="flex items-center justify-between py-1.5 border-b last:border-0">
                      <div>
                        <p className="text-sm font-medium">{d.hostname ?? d.serial ?? d.id.slice(0, 8)}</p>
                        <p className="text-xs font-mono text-muted-foreground">{lease?.ip_address ?? '—'}</p>
                      </div>
                      <div className="text-right">
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${STATUS_COLORS[d.status]}`}>
                          {d.status}
                        </span>
                        <p className="text-xs text-muted-foreground mt-0.5">{formatRelative(d.provisioned_at!)}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </div>

        {/* Recent alerts from syslog */}
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Recent Alerts</h2>
              <span className="text-xs text-muted-foreground">(warn or worse)</span>
            </div>
            <button onClick={() => navigate('/events')}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
              View all <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          {recentAlerts.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-green-600 py-2">
              <CheckCircle2 className="h-4 w-4" /> No recent alerts
            </div>
          ) : (
            <div className="space-y-2">
              {recentAlerts.map(e => {
                const sev = SEVERITY_LABEL[e.severity]
                return (
                  <div key={e.id} className="flex items-start gap-2 py-1.5 border-b last:border-0">
                    <span className={`text-[10px] font-bold font-mono mt-0.5 w-10 shrink-0 ${sev?.color ?? 'text-muted-foreground'}`}>
                      {sev?.label ?? e.severity}
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs truncate">{e.message}</p>
                      <p className="text-xs text-muted-foreground">{e.source_ip} · {formatRelative(e.received_at)}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

      </div>

      {/* Active leases + DHCP activity */}
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Wifi className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Active DHCP Leases</h2>
            <span className="text-xs text-muted-foreground">{leases.length} total</span>
          </div>
          <button onClick={() => navigate('/leases')}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
            View all <ArrowRight className="h-3 w-3" />
          </button>
        </div>
        {leases.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active leases.</p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {leases.slice(0, 12).map(l => {
              const device = devices.find(d =>
                (d.mac && l.hw_address === d.mac) || (d.hostname && l.hostname === d.hostname)
              )
              return (
                <div key={l.ip_address}
                  className="flex items-center gap-2 p-2 rounded-lg border bg-muted/30 text-xs">
                  <Activity className="h-3 w-3 text-green-500 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-mono font-medium truncate">{l.ip_address}</p>
                    <p className="text-muted-foreground truncate">{device?.hostname ?? l.hostname ?? l.hw_address}</p>
                  </div>
                </div>
              )
            })}
            {leases.length > 12 && (
              <div className="flex items-center justify-center p-2 rounded-lg border border-dashed text-xs text-muted-foreground">
                +{leases.length - 12} more
              </div>
            )}
          </div>
        )}
      </div>

      {/* Config drift placeholder — links to devices with profiles */}
      {withProfiles.length > 0 && (
        <div className="rounded-xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GitCompare className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Config Drift</h2>
              <span className="text-xs text-muted-foreground">
                {withProfiles.length} device{withProfiles.length !== 1 ? 's' : ''} with profiles — open device drawer to diff
              </span>
            </div>
            <button onClick={() => navigate('/devices')}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
              View devices <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}

    </div>
  )
}
