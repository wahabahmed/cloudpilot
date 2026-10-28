import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, ApiError } from '../lib/api';

interface User {
  user_id: number;
  email: string;
  name: string;
  role: string;
  team_id: number | null;
  tenant_id: number;
  tenant_name: string;
}

interface AuthCtx {
  token: string | null;
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshLicense: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);
const TOKEN_KEY = 'cloudpilot_token';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const clearAuth = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  };

  useEffect(() => {
    const onUnauthorized = () => clearAuth();
    window.addEventListener('cloudpilot:unauthorized', onUnauthorized);
    return () => window.removeEventListener('cloudpilot:unauthorized', onUnauthorized);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!token) { setLoading(false); return; }
    setLoading(true);
    Promise.all([
      api.me().catch((e) => {
        if (e instanceof ApiError && e.status === 401) clearAuth();
        return null;
      }),
      api.licenseStatus().catch(() => null),
    ]).then(([u, l]) => {
      if (cancelled) return;
      if (u) setUser(u as User);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [token]);

  const login = async (email: string, password: string) => {
    const res = await api.login(email, password);
    localStorage.setItem(TOKEN_KEY, res.token);
    setToken(res.token);
    const [u, l] = await Promise.all([
      api.me().catch(() => null),
      api.licenseStatus().catch(() => null),
    ]);
    if (u) setUser(u as User);
  };

  const logout = () => {
    clearAuth();
    window.location.href = '/login';
  };

  const refreshLicense = async () => {
    const l = await api.licenseStatus().catch(() => null);
    if (l) setLicense(l as License);
  };

  return (
    <Ctx.Provider value={{ token, user, loading, login, logout, }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}