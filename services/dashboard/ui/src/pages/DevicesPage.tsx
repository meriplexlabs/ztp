import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type Device, type DeviceProfile } from '@/lib/api'
import { formatRelative } from '@/lib/utils'
import { Server, RefreshCw, X, Plus, Trash2 } from 'lucide-react'

const STATUS_COLORS: Record<Device['status'], string> = {
  unknown:      'bg-gray-100 text-gray-700',
  discovered:   'bg-blue-100 text-blue-700',
  provisioning: 'bg-yellow-100 text-yellow-700',
  provisioned:  'bg-green-100 text-green-700',
  failed:       'bg-red-100 text-red-700',
  ignored:      'bg-gray-100 text-gray-500',
}

function DeviceDrawer({
  device,
  profiles,
  onClose,
}: {
  device: Device
  profiles: DeviceProfile[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [hostname, setHostname] = useState(device.hostname ?? '')
  const [profileId, setProfileId] = useState(device.profile_id ?? '')
  const [vars, setVars] = useState<[string, string][]>(
    Object.entries(device.variables ?? {}).map(([k, v]) => [k, String(v)])
  )
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (body: Partial<Device>) =>
      api.put<Device>(`/api/v1/devices/${device.id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] })
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  const del = useMutation({
    mutationFn: () => api.delete(`/api/v1/devices/${device.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] })
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  function handleSave() {
    setError(null)
    const variables = Object.fromEntries(vars.filter(([k]) => k.trim() !== ''))
    save.mutate({
      ...device,
      hostname: hostname || undefined,
      profile_id: profileId || undefined,
      variables,
    })
  }

  function addVar() { setVars(v => [...v, ['', '']]) }
  function removeVar(i: number) { setVars(v => v.filter((_, j) => j !== i)) }
  function setVarKey(i: number, k: string) {
    setVars(v => v.map((pair, j) => j === i ? [k, pair[1]] : pair))
  }
  function setVarVal(i: number, val: string) {
    setVars(v => v.map((pair, j) => j === i ? [pair[0], val] : pair))
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-[420px] bg-background border-l shadow-xl z-50 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <p className="font-semibold text-sm">{device.serial ?? device.mac ?? device.id}</p>
            {device.description && (
              <p className="text-xs text-muted-foreground">{device.description}</p>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Read-only info */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Serial</p>
              <p className="font-mono">{device.serial ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">MAC</p>
              <p className="font-mono">{device.mac ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Status</p>
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[device.status]}`}>
                {device.status}
              </span>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Last Seen</p>
              <p>{device.last_seen ? formatRelative(device.last_seen) : '—'}</p>
            </div>
          </div>

          {/* Hostname */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Hostname
            </label>
            <input
              type="text"
              value={hostname}
              onChange={e => setHostname(e.target.value)}
              placeholder="e.g. sw-core-01"
              className="w-full text-sm border rounded px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* Profile */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Profile
            </label>
            <select
              value={profileId}
              onChange={e => setProfileId(e.target.value)}
              className="w-full text-sm border rounded px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="">— No profile —</option>
              {profiles.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Variables */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-muted-foreground">Variables</label>
              <button
                onClick={addVar}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3 w-3" /> Add
              </button>
            </div>
            <div className="space-y-2">
              {vars.map(([k, v], i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    type="text"
                    value={k}
                    onChange={e => setVarKey(i, e.target.value)}
                    placeholder="key"
                    className="flex-1 text-xs border rounded px-2 py-1.5 bg-background font-mono focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                  <input
                    type="text"
                    value={v}
                    onChange={e => setVarVal(i, e.target.value)}
                    placeholder="value"
                    className="flex-1 text-xs border rounded px-2 py-1.5 bg-background font-mono focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                  <button onClick={() => removeVar(i)} className="text-muted-foreground hover:text-destructive">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {vars.length === 0 && (
                <p className="text-xs text-muted-foreground">No variables set</p>
              )}
            </div>
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-5 py-4 flex items-center justify-between">
          <button
            onClick={() => { if (confirm('Delete this device?')) del.mutate() }}
            disabled={del.isPending}
            className="flex items-center gap-1.5 text-sm text-destructive hover:opacity-80 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="text-sm px-4 py-2 rounded border hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={save.isPending}
              className="text-sm px-4 py-2 rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

export default function DevicesPage() {
  const [selected, setSelected] = useState<Device | null>(null)
  const { data: devices, isLoading, error, refetch, isFetching } = useQuery<Device[]>({
    queryKey: ['devices'],
    queryFn: () => api.get<Device[]>('/api/v1/devices'),
    refetchInterval: 30_000,
  })
  const { data: profiles = [] } = useQuery<DeviceProfile[]>({
    queryKey: ['profiles'],
    queryFn: () => api.get<DeviceProfile[]>('/api/v1/profiles'),
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
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Profile</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d, i) => {
                const profile = profiles.find(p => p.id === d.profile_id)
                return (
                  <tr
                    key={d.id}
                    onClick={() => setSelected(d)}
                    className={`cursor-pointer hover:bg-muted/40 transition-colors ${i % 2 === 0 ? '' : 'bg-muted/20'}`}
                  >
                    <td className="px-4 py-3 font-medium">{d.hostname ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-4 py-3 font-mono text-xs">{d.mac ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs">{d.serial ?? '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{profile?.name ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[d.status]}`}>
                        {d.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {d.last_seen ? formatRelative(d.last_seen) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <DeviceDrawer
          device={selected}
          profiles={profiles}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
