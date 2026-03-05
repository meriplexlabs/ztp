import { create } from 'zustand'
import { api, setToken, clearToken, type LoginResponse } from '@/lib/api'

interface AuthState {
  user: LoginResponse['user'] | null
  isAuthenticated: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  checkAuth: () => Promise<void>
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: !!localStorage.getItem('ztp_token'),

  login: async (username, password) => {
    const res = await api.post<LoginResponse>('/api/v1/auth/login', { username, password })
    setToken(res.token)
    set({ user: res.user, isAuthenticated: true })
  },

  logout: async () => {
    try { await api.post('/api/v1/auth/logout', {}) } catch {}
    clearToken()
    set({ user: null, isAuthenticated: false })
  },

  checkAuth: async () => {
    try {
      const claims = await api.get<LoginResponse['user']>('/api/v1/auth/me')
      set({ user: claims, isAuthenticated: true })
    } catch {
      clearToken()
      set({ user: null, isAuthenticated: false })
    }
  },
}))
