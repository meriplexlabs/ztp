import { useQuery } from '@tanstack/react-query'
import { api, type ConfigTemplate } from '@/lib/api'
import { FileCode2 } from 'lucide-react'

const VENDOR_COLORS: Record<string, string> = {
  cisco:    'bg-blue-100 text-blue-700',
  aruba:    'bg-orange-100 text-orange-700',
  juniper:  'bg-green-100 text-green-700',
  extreme:  'bg-purple-100 text-purple-700',
  fortinet: 'bg-red-100 text-red-700',
}

export default function TemplatesPage() {
  const { data: templates, isLoading, error } = useQuery<ConfigTemplate[]>({
    queryKey: ['templates'],
    queryFn: () => api.get<ConfigTemplate[]>('/api/v1/templates'),
  })

  const grouped = templates?.reduce((acc, t) => {
    const key = t.vendor
    if (!acc[key]) acc[key] = []
    acc[key].push(t)
    return acc
  }, {} as Record<string, ConfigTemplate[]>)

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <FileCode2 className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Config Templates</h1>
      </div>

      {isLoading && <div className="text-muted-foreground text-sm">Loading templates…</div>}
      {error && <div className="text-destructive text-sm">Failed to load templates</div>}

      {grouped && Object.entries(grouped).map(([vendor, items]) => (
        <div key={vendor} className="mb-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3 capitalize">
            {vendor}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map(t => (
              <div key={t.id} className="border rounded-lg p-4 bg-card hover:shadow-sm transition-shadow">
                <div className="flex items-start justify-between mb-2">
                  <p className="font-medium text-sm">{t.name}</p>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${VENDOR_COLORS[t.vendor] ?? 'bg-gray-100 text-gray-700'}`}>
                    {t.os_type}
                  </span>
                </div>
                {t.file_path && (
                  <p className="text-xs text-muted-foreground font-mono">{t.file_path}</p>
                )}
                {t.variables.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-2">
                    {t.variables.length} variable{t.variables.length !== 1 ? 's' : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
