import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import {
  Server, FileCode2, Network, ScrollText, Settings, LogOut, Router,
  Users, LayoutDashboard, ClipboardList, Bell,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/hooks/useAuth'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

const nav = [
  { to: '/',          label: 'Overview',    icon: LayoutDashboard },
  { to: '/devices',   label: 'Devices',     icon: Server },
  { to: '/templates', label: 'Templates',   icon: FileCode2 },
  { to: '/profiles',  label: 'Profiles',    icon: Users },
  { to: '/leases',    label: 'DHCP Leases', icon: Network },
  { to: '/events',    label: 'Events',      icon: ScrollText },
  { to: '/audit',     label: 'Audit Log',   icon: ClipboardList },
  { to: '/settings',  label: 'Settings',    icon: Settings },
]

export default function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const { data: alertCount } = useQuery<{ count: number }>({
    queryKey: ['alert-count'],
    queryFn: () => api.get<{ count: number }>('/api/v1/alerts/count'),
    refetchInterval: 60_000,
  })

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-60 border-r bg-card flex flex-col">
        {/* Logo */}
        <div className="flex items-center gap-2 px-6 py-5 border-b">
          <Router className="h-6 w-6 text-primary" />
          <span className="font-semibold text-lg tracking-tight">ZTP Server</span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}

          {/* Alerts — separate entry with badge */}
          <NavLink
            to="/alerts"
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )
            }
          >
            <Bell className="h-4 w-4" />
            Alerts
            {alertCount && alertCount.count > 0 && (
              <span className="ml-auto text-xs px-1.5 py-0.5 rounded-full bg-red-500 text-white font-medium min-w-[20px] text-center">
                {alertCount.count}
              </span>
            )}
          </NavLink>
        </nav>

        {/* User + logout */}
        <div className="border-t px-4 py-4 flex items-center justify-between">
          <div className="text-sm">
            <p className="font-medium">{user?.username ?? '—'}</p>
            <p className="text-xs text-muted-foreground capitalize">{user?.role}</p>
          </div>
          <button
            onClick={handleLogout}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title="Log out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
