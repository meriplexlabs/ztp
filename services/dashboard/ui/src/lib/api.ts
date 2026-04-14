// API client — thin wrapper around fetch that handles auth headers and base URL.

const BASE_URL = import.meta.env.VITE_API_URL || ''

function getToken(): string | null {
  return localStorage.getItem('ztp_token')
}

export function setToken(token: string) {
  localStorage.setItem('ztp_token', token)
}

export function clearToken() {
  localStorage.removeItem('ztp_token')
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: HeadersInit = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  if (res.status === 401) {
    clearToken()
    if (window.location.pathname !== '/login') {
      window.location.href = '/login'
    }
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText)
  }

  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  get:    <T>(path: string)             => request<T>('GET', path),
  post:   <T>(path: string, body: unknown) => request<T>('POST', path, body),
  put:    <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string)             => request<T>('DELETE', path),
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Device {
  id: string
  mac?: string
  serial?: string
  vendor_class?: string
  hostname?: string
  description?: string
  status: 'unknown' | 'discovered' | 'provisioning' | 'provisioned' | 'failed' | 'ignored'
  profile_id?: string
  variables: Record<string, unknown>
  last_seen?: string
  provisioned_at?: string
  created_at: string
  updated_at: string
}

export interface ConfigTemplate {
  id: string
  name: string
  vendor: string
  os_type: string
  file_path?: string
  content?: string
  variables: TemplateVar[]
  created_at: string
  updated_at: string
}

export interface TemplateVar {
  name: string
  description?: string
  required: boolean
  default?: string
}

export interface DeviceProfile {
  id: string
  name: string
  description?: string
  template_id?: string
  variables: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface SyslogEvent {
  id: number
  device_id?: string
  source_ip: string
  severity: number
  facility: number
  hostname?: string
  app_name?: string
  message: string
  received_at: string
}

export interface DHCPLease {
  ip_address: string
  hw_address: string
  hostname?: string
  valid_lft: number
  subnet_id: number
  state: number
}

export interface AuthInfo {
  oidc_enabled: boolean
  local_enabled: boolean
}

export interface LoginResponse {
  token: string
  expires: number
  user: { id: string; username: string; email?: string; role: string }
}

export const SEVERITY_LABELS: Record<number, string> = {
  0: 'Emergency', 1: 'Alert', 2: 'Critical', 3: 'Error',
  4: 'Warning', 5: 'Notice', 6: 'Info', 7: 'Debug',
}
