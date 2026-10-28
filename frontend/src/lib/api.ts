const API_BASE = '/api';

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

function getToken(): string | null {
  return localStorage.getItem('cloudpilot_token');
}

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.append(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `${path}?${qs}` : path;
}

function loadingStart() {
  const bar = document.getElementById('loading-bar');
  if (!bar) return;
  bar.classList.add('active');
  bar.style.width = '20%';
  setTimeout(() => { bar.style.width = '70%'; }, 100);
}

function loadingEnd() {
  const bar = document.getElementById('loading-bar');
  if (!bar) return;
  bar.style.width = '100%';
  setTimeout(() => {
    bar.classList.remove('active');
    bar.style.width = '0%';
  }, 250);
}

function detailToMessage(detail: unknown, status: number): string {
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((d: any) => {
      const loc = Array.isArray(d?.loc) ? d.loc.join('.') : '';
      const msg = d?.msg ?? JSON.stringify(d);
      return loc ? `${loc}: ${msg}` : msg;
    });
    if (parts.length) return parts.join('; ');
  }
  if (detail && typeof detail === 'object') return JSON.stringify(detail);
  return `Request failed: ${status}`;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  loadingStart();
  try {
    const token = getToken();
    const headers: Record<string, string> = {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers as Record<string, string> | undefined),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    } catch (e: any) {
      throw new ApiError(
        `Network error: ${e?.message ?? 'request failed'}. Is the backend running?`,
        0,
        null,
      );
    }

    if (res.status === 401) {
      localStorage.removeItem('cloudpilot_token');
      window.dispatchEvent(new Event('cloudpilot:unauthorized'));
      throw new ApiError('Session expired. Please sign in again.', 401, null);
    }

    if (!res.ok) {
      let body: any = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      const detail = body?.detail ?? res.statusText;
      throw new ApiError(detailToMessage(detail, res.status), res.status, detail);
    }

    if (res.status === 204) return undefined as unknown as T;

    try {
      return await res.json();
    } catch {
      return undefined as unknown as T;
    }
  } finally {
    loadingEnd();
  }
}

export const api = {
  // ---------- Auth ----------
  login: (email: string, password: string) =>
    request<{ token: string; tenant_id: number; role: string }>(
      `/auth/login?email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
      { method: 'POST' }
    ),
  me: () =>
    request<{
      user_id: number;
      email: string;
      name: string;
      role: string;
      team_id: number | null;
      tenant_id: number;
      tenant_name: string;
    }>('/me'),

  // ---------- Dashboard ----------
  costTrend: (tid: number, days = 30) =>
    request<{ date: string; amount: number }[]>(
      `/tenants/${tid}/finance/trend?days=${days}`
    ),

  tenantFinance: (tid: number, days = 30, env?: string, provider?: string) => {
    const params = new URLSearchParams();
    params.append('days', String(days));
    if (env) params.append('env', env);
    if (provider) params.append('provider', provider);
    return request<{ total_cost: number; accounts: any[] }>(
      `/tenants/${tid}/finance/resources?${params.toString()}`
    );
  },

  // ---------- Requests ----------
  listRequests: (tid: number, opts?: {
    status?: string;
    env?: string;
    requested_by?: number;
    page?: number;
    limit?: number;
  }) =>
    request<{
      items: any[];
      total: number;
      page: number;
      pages: number;
      limit: number;
    }>(
      withQuery(`/tenants/${tid}/requests`, {
        status: opts?.status,
        env: opts?.env,
        requested_by: opts?.requested_by,
        page: opts?.page ?? 1,
        limit: opts?.limit ?? 10,
      })
    ),

  submitRequest: (
    tid: number,
    account_id: number,
    nlp_text: string,
    workflow_id?: number
  ) =>
    request<{ request_id: number; status: string; total_steps: number }>(
      withQuery(`/tenants/${tid}/requests`, {
        account_id,
        nlp_text,
        workflow_id,
      }),
      { method: 'POST' }
    ),

  getRequest: (rid: number) => request<any>(`/requests/${rid}`),

  approveRequest: (rid: number) =>
    request<{ request_id: number; status: string; current_step: number }>(
      `/requests/${rid}/approve`,
      { method: 'POST' }
    ),

  rejectRequest: (rid: number, reason = '') =>
    request<{ request_id: number; status: string }>(
      `/requests/${rid}/reject?reason=${encodeURIComponent(reason)}`,
      { method: 'POST' }
    ),

  // ---------- Inventory / Accounts ----------
  listAccounts: (tid: number, opts?: {
    env?: string;
    provider?: string;
    team_id?: number;
    page?: number;
    limit?: number;
  }) =>
    request<{ items: any[]; total: number; page: number; pages: number; limit: number }>(
      withQuery(`/tenants/${tid}/accounts`, {
        env: opts?.env,
        provider: opts?.provider,
        team_id: opts?.team_id,
        page: opts?.page ?? 1,
        limit: opts?.limit ?? 10,
      })
    ),

  addAccount: (
    tid: number,
    opts: {
      provider: string;
      account_ref: string;
      env: string;
      cloud_account_id?: string;
      credential_id?: number;
    }
  ) =>
    request<{
      id: number;
      provider: string;
      account_ref: string;
      cloud_account_id: string | null;
      env: string;
      state_key: string;
      root_credential_id: number | null;
    }>(
      withQuery(`/tenants/${tid}/accounts`, {
        provider: opts.provider,
        account_ref: opts.account_ref,
        env: opts.env,
        cloud_account_id: opts.cloud_account_id,
        credential_id: opts.credential_id,
      }),
      { method: 'POST' }
    ),

  verifyAccount: (aid: number) =>
    request<{ valid: boolean; error: string }>(`/accounts/${aid}/verify`, {
      method: 'POST',
    }),

  createSubaccount: (
    tid: number,
    aid: number,
    opts: {
      name: string;
      email?: string;
      parent?: string;
      billing_scope?: string;
    }
  ) =>
    request<{
      account_id: number;
      provider: string;
      account_ref: string;
      cloud_account_id: string;
      status: string;
      note: string;
    }>(
      withQuery(`/tenants/${tid}/accounts/${aid}/create-subaccount`, {
        name: opts.name,
        email: opts.email,
        parent: opts.parent,
        billing_scope: opts.billing_scope,
      }),
      { method: 'POST' }
    ),

  // ---------- Account ↔ Team ----------
  attachAccount: (team_id: number, account_id: number) =>
    request<{ status: string }>(`/teams/${team_id}/accounts/${account_id}`, {
      method: 'POST',
    }),

  detachAccount: (team_id: number, account_id: number) =>
    request<{ status: string }>(`/teams/${team_id}/accounts/${account_id}`, {
      method: 'DELETE',
    }),

  listAccountTeams: (tid: number) =>
    request<Record<string, { id: number; name: string }[]>>(
      `/tenants/${tid}/account-teams`
    ),

  listAccountResources: (accountId: number, opts?: { resource_type?: string; page?: number; limit?: number }) =>
    request<{
      items: any[];
      total: number;
      page: number;
      pages: number;
      limit: number;
      account_id: number;
      provider: string;
      env: string;
    }>(
      withQuery(`/accounts/${accountId}/resources`, {
        resource_type: opts?.resource_type,
        page: opts?.page ?? 1,
        limit: opts?.limit ?? 10,
      })
    ),

  listInventory: (tid: number, opts?: { env?: string; account_id?: number; resource_type?: string }) => {
    const params = new URLSearchParams();
    if (opts?.env) params.append('env', opts.env);
    if (opts?.account_id) params.append('account_id', String(opts.account_id));
    if (opts?.resource_type) params.append('resource_type', opts.resource_type);
    const qs = params.toString();
    return request<any[]>(`/tenants/${tid}/inventory${qs ? '?' + qs : ''}`);
  },

  syncInventory: (tid: number) =>
    request<{ accounts_synced: number; total: number }>(
      `/tenants/${tid}/inventory/sync`,
      { method: 'POST' }
    ),

  // ---------- Cloud Setup (root credential) ----------
  listCredentials: (tid: number) => request<any[]>(`/tenants/${tid}/credentials`),

  storeCredential: (tid: number, provider: string, env: string, payload: object) =>
    request<{ id: number; provider: string; env: string; created: boolean }>(
      `/tenants/${tid}/credentials?provider=${provider}&env=${env}`,
      { method: 'POST', body: JSON.stringify(payload) }
    ),

  verifyCredential: (tid: number, cid: number) =>
    request<{ valid: boolean; error: string }>(
      `/tenants/${tid}/credentials/${cid}/verify`,
      { method: 'POST' }
    ),

  // ---------- Finance ----------
  tenantFinanceByEnv: (tid: number, days: number, env?: string) =>
    request<{ total_cost: number; accounts: any[] }>(
      `/tenants/${tid}/finance/resources?days=${days}${env ? `&env=${env}` : ''}`
    ),

  financeSummary: (tid: number, days = 30) =>
    request<{
      tenant_id: number;
      period_days: number;
      teams: {
        team_id: number | null;
        team_name: string;
        user_count: number;
        account_count: number;
        budget: number;
        cost: number;
        utilization: number | null;
      }[];
    }>(`/tenants/${tid}/finance/summary?days=${days}`),

  listRecommendations: (tid: number, status: string = 'open') =>
    request<{
      id: number;
      account_id: number;
      resource_id: string;
      rule: string;
      finding: string;
      monthly_savings: number;
      effort: string;
      status: string;
      created_at: string | null;
    }[]>(`/tenants/${tid}/finance/recommendations?status=${status}`),

  dismissRecommendation: (tid: number, rid: number, status: string = 'dismissed') =>
    request<{ id: number; status: string }>(
      `/tenants/${tid}/finance/recommendations/${rid}?status=${status}`,
      { method: 'PATCH' }
    ),

  // ---------- Teams & Users ----------
  createTeam: (tid: number, name: string) =>
    request<any>(`/tenants/${tid}/teams?name=${encodeURIComponent(name)}`, {
      method: 'POST',
    }),

  listTeams: (tid: number, opts?: { page?: number; limit?: number; search?: string }) =>
    request<{ items: any[]; total: number; page: number; pages: number; limit: number }>(
      withQuery(`/tenants/${tid}/teams`, {
        page: opts?.page ?? 1,
        limit: opts?.limit ?? 10,
        search: opts?.search,
      })
    ),

  updateTeam: (team_id: number, name: string) =>
    request<any>(`/teams/${team_id}?name=${encodeURIComponent(name)}`, {
      method: 'PATCH',
    }),

  deleteTeam: (team_id: number) =>
    request<{ status: string; team_id: number }>(`/teams/${team_id}`, {
      method: 'DELETE',
    }),

  listUsers: (tid: number, opts?: { page?: number; limit?: number; team_id?: number; search?: string }) =>
    request<{ items: any[]; total: number; page: number; pages: number; limit: number }>(
      withQuery(`/tenants/${tid}/users`, {
        page: opts?.page ?? 1,
        limit: opts?.limit ?? 10,
        team_id: opts?.team_id,
        search: opts?.search,
      })
    ),

  createUser: (
    tid: number,
    email: string,
    name: string,
    password: string,
    team_id?: number,
    role = 'member'
  ) =>
    request<any>(
      withQuery(`/tenants/${tid}/users`, {
        email, name, password, team_id, role,
      }),
      { method: 'POST' }
    ),

  updateUser: (uid: number, opts?: { role?: string; team_id?: number }) =>
    request<any>(
      withQuery(`/users/${uid}`, { role: opts?.role, team_id: opts?.team_id }),
      { method: 'PATCH' }
    ),

  deleteUser: (uid: number) =>
    request<{ status: string; user_id: number }>(`/users/${uid}`, {
      method: 'DELETE',
    }),

  // ---------- Workflows ----------
  listWorkflows: (tid: number) => request<any[]>(`/tenants/${tid}/workflows`),

  createWorkflow: (tid: number, name: string, steps: any[]) =>
    request<any>(`/tenants/${tid}/workflows`, {
      method: 'POST',
      body: JSON.stringify({ name, steps }),
    }),

  updateWorkflow: (wid: number, name: string, steps: any[]) =>
    request<any>(`/workflows/${wid}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, steps }),
    }),

  // ---------- Applications & Pipelines ----------
  onboardApp: (
    tid: number,
    repo_url: string,
    branch: string,
    cluster_id: number,
    namespace: string,
    release_name: string,
    env: string,
    repo_token?: string
  ) =>
    request<{ application_id: number; status: string; has_repo_token: boolean }>(
      withQuery(`/tenants/${tid}/applications`, {
        repo_url, branch, cluster_id, namespace,
        release_name, env, repo_token,
      }),
      { method: 'POST' }
    ),

  updateApplication: (aid: number, opts?: { branch?: string; repo_token?: string }) =>
    request<{ id: number; branch: string; has_repo_token: boolean }>(
      withQuery(`/applications/${aid}`, {
        branch: opts?.branch,
        repo_token: opts?.repo_token,
      }),
      { method: 'PATCH' }
    ),

  listApplications: (tid: number, opts?: { env?: string; page?: number; limit?: number }) =>
    request<{ items: any[]; total: number; page: number; pages: number; limit: number }>(
      withQuery(`/tenants/${tid}/applications`, {
        env: opts?.env,
        page: opts?.page ?? 1,
        limit: opts?.limit ?? 10,
      })
    ),

  triggerDeploy: (app_id: number, commit_sha: string, image: string) =>
    request<{ pipeline_run_id: number; status: string }>(
      `/applications/${app_id}/deploy?commit_sha=${commit_sha}&image=${encodeURIComponent(image)}`,
      { method: 'POST' }
    ),

  listPipelines: (app_id: number) =>
    request<{ application_id: number; repo_url: string; runs: any[] }>(
      `/applications/${app_id}/pipelines`
    ),

  pipelineStats: (tid: number, days = 7) =>
    request<{ deploys: number; success_rate: number; failed: number }>(
      `/tenants/${tid}/pipelines/stats?days=${days}`
    ),

  // ---------- Import ----------
  discoverImportable: (account_id: number, region = 'us-east-1') =>
    request<{ account_id: number; provider: string; resources: any[]; count: number }>(
      `/accounts/${account_id}/import/discover`,
      { method: 'POST', body: JSON.stringify({ region }) }
    ),

  startImport: (account_id: number, resource_ids: string[], region = 'us-east-1') =>
    request<{
      request_id: number;
      status: string;
      resource_count: number;
      hcl_preview: string;
      skipped_already_imported: number;
    }>(`/accounts/${account_id}/import`, {
      method: 'POST',
      body: JSON.stringify({ region, resource_ids }),
    })
};