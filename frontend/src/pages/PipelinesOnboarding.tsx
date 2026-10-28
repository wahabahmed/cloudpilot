import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { CloudIcon } from '../components/CloudIcon';
import { CloudSelect } from '../components/CloudSelect';
import { Pagination } from '../components/Pagination';

type Step = 1 | 2 | 3 | 4;

export function PipelinesOnboarding() {
  const { user } = useAuth();

  // ---------- onboarding state ----------
  const [step, setStep] = useState<Step>(1);
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [repoToken, setRepoToken] = useState('');        // NEW — optional, for private repos
  const [clusterId, setClusterId] = useState<string>('');
  const [namespace, setNamespace] = useState('default');
  const [releaseName, setReleaseName] = useState('');
  const [env, setEnv] = useState('DEV');

  // ---------- pipelines state ----------
  const [apps, setApps] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [runsByApp, setRunsByApp] = useState<Record<number, any[]>>({});
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [stats, setStats] = useState<any>(null);

  // ---------- per-app credentials editing state ----------
  const [tokenDraft, setTokenDraft] = useState<Record<number, string>>({});
  const [tokenBusy, setTokenBusy] = useState<Record<number, boolean>>({});
  const [tokenMsg, setTokenMsg] = useState<Record<number, { kind: 'ok' | 'err'; text: string } | undefined>>({});

  // ---------- filter state ----------
  const [search, setSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [envFilter, setEnvFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const [appPage, setAppPage] = useState(1);
  const [appTotal, setAppTotal] = useState(0);
  const [appPages, setAppPages] = useState(1);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    if (!user) return;
    try {
      const [a, c, s] = await Promise.all([
        api.listApplications(user.tenant_id, { page: appPage, limit: 10 }),
        api.listAccounts(user.tenant_id),
        api.pipelineStats(user.tenant_id, 7).catch(() => null),
      ]);
      setApps(a.items);
      setAppTotal(a.total);
      setAppPages(a.pages);

      setAccounts(c.items);
      setStats(s);

      const runs: Record<number, any[]> = {};
      for (const app of a.items) {
        const p = await api.listPipelines(app.id).catch(() => ({ runs: [] }));
        runs[app.id] = (p as any).runs ?? [];
      }
      setRunsByApp(runs);

      if (!clusterId && c.items.length) setClusterId(c.items[0].id.toString());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, [user, appPage]);

  if (!user) return null;
  const canOnboard = user.role === 'admin' || user.role === 'member';

  // ---------- onboard action ----------
  const onboard = async () => {
    setError(''); setMessage(''); setSaving(true);
    try {
      if (!repoUrl || !clusterId) throw new Error('repo URL and cluster are required');
      const rel = releaseName || repoUrl.split('/').pop() || 'app';
      await api.onboardApp(
        user.tenant_id, repoUrl, branch, parseInt(clusterId),
        namespace, rel, env,
        repoToken || undefined,                            // NEW
      );
      setMessage(`Onboarded ${repoUrl} → cluster ${clusterId} (${env}).`);
      setRepoUrl(''); setReleaseName(''); setRepoToken('');
      setStep(1);
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const deploy = async (appId: number) => {
    setError(''); setMessage('');
    try {
      const sha = Math.random().toString(16).slice(2, 9);
      const img = `release-${appId}:${sha}`;
      const res = await api.triggerDeploy(appId, sha, img);
      setMessage(`Deploy enqueued: run ${res.pipeline_run_id} (status ${res.status}).`);
      setTimeout(refresh, 1500);
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ---------- repo token actions (per application) ----------
  const saveToken = async (appId: number, token: string) => {
    setTokenBusy((b) => ({ ...b, [appId]: true }));
    setTokenMsg((m) => ({ ...m, [appId]: undefined }));
    try {
      await api.updateApplication(appId, { repo_token: token });
      setTokenMsg((m) => ({ ...m, [appId]: { kind: 'ok', text: token ? 'Token saved.' : 'Token cleared.' } }));
      setTokenDraft((d) => ({ ...d, [appId]: '' }));
      refresh();
    } catch (e: any) {
      setTokenMsg((m) => ({ ...m, [appId]: { kind: 'err', text: e.message } }));
    } finally {
      setTokenBusy((b) => ({ ...b, [appId]: false }));
    }
  };

  // ---------- filtering ----------
  const findAccount = (id: number) => accounts.find((a) => a.id === id);

  const filteredApps = useMemo(() => {
    const q = search.trim().toLowerCase();
    return apps.filter((app) => {
      if (q) {
        const cluster = findAccount(app.cluster_id);
        const haystack = [
          app.repo_url,
          app.release_name,
          app.namespace,
          cluster?.account_ref ?? '',
        ].join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (providerFilter) {
        const cluster = findAccount(app.cluster_id);
        if (!cluster || cluster.provider !== providerFilter) return false;
      }
      if (envFilter && app.env !== envFilter) return false;
      if (statusFilter) {
        const runs = runsByApp[app.id] ?? [];
        const latest = runs[0];
        if (statusFilter === 'none') {
          if (runs.length > 0) return false;
        } else {
          if (!latest || latest.status !== statusFilter) return false;
        }
      }
      return true;
    });
  }, [apps, runsByApp, accounts, search, providerFilter, envFilter, statusFilter]);

  const clearFilters = () => {
    setSearch('');
    setProviderFilter('');
    setEnvFilter('');
    setStatusFilter('');
  };

  const hasFilters = search || providerFilter || envFilter || statusFilter;

  return (
    <>
      <div className="row">
        <div>
          <h1 className="h1">Pipelines</h1>
          <p className="sub">Onboard a repository, deploy it to a cluster, and watch the runs.</p>
        </div>
      </div>

      {/* ======================= STEPPER ======================= */}
      <div className="stepper">
        {[1, 2, 3, 4].map((n) => (
          <div key={n} className={`stepper-step ${step === n ? 'active' : ''} ${step > n ? 'done' : ''}`}>
            <div className="stepper-dot">{step > n ? '✓' : n}</div>
            <div className="stepper-label">
              {n === 1 && 'Git repo'}
              {n === 2 && 'Cluster'}
              {n === 3 && 'Helm'}
              {n === 4 && 'Review'}
            </div>
          </div>
        ))}
      </div>

      {/* ======================= STEP 1: REPO ======================= */}
      {step === 1 && (
        <div className="card">
          <h2 className="card-h">Connect a repository</h2>
          <p className="card-s">Point at a git repo. CloudPilot will clone, build, and deploy it with Helm.</p>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14 }}>
            <div className="field">
              <label>Repository URL</label>
              <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)}
                     placeholder="https://github.com/acme/payments-service" />
            </div>
            <div className="field">
              <label>Branch</label>
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
            </div>
          </div>

          {/* NEW — repository access token */}
          <div className="field">
            <label>Repository access token <span className="muted">(optional — required for private repos)</span></label>
            <input
              type="password"
              value={repoToken}
              onChange={(e) => setRepoToken(e.target.value)}
              placeholder="ghp_… / glpat-… / app-password"
              autoComplete="off"
            />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              GitHub: <code>repo</code> scope · GitLab: <code>read_repository</code> · Bitbucket: repository read.
              Stored encrypted at rest; never returned to the browser.
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" disabled={!repoUrl} onClick={() => setStep(2)}>
              Continue →
            </button>
          </div>
        </div>
      )}

      {/* ======================= STEP 2: CLUSTER ======================= */}
      {step === 2 && (
        <div className="card">
          <h2 className="card-h">Choose a target cluster</h2>
          <p className="card-s">Only clusters CloudPilot already manages appear here.</p>
          {accounts.length === 0 ? (
            <div className="warn-box">
              No cloud accounts yet. Add one on the <b>Cloud Setup</b> page first.
            </div>
          ) : (
            <div className="field">
              <label>Cluster (account)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {clusterId && accounts.find((a) => a.id === parseInt(clusterId)) && (
                  <CloudIcon
                    provider={accounts.find((a) => a.id === parseInt(clusterId))!.provider}
                    size={20}
                  />
                )}
                <select
                  value={clusterId}
                  onChange={(e) => setClusterId(e.target.value)}
                  style={{ flex: 1 }}
                >
                  <option value="">— pick a cluster —</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.account_ref} · {a.provider.toUpperCase()} · {a.env}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <button className="btn" onClick={() => setStep(1)}>← Back</button>
            <button className="btn btn-primary" disabled={!clusterId} onClick={() => setStep(3)}>
              Continue →
            </button>
          </div>
        </div>
      )}

      {/* ======================= STEP 3: HELM ======================= */}
      {step === 3 && (
        <div className="card">
          <h2 className="card-h">Helm configuration</h2>
          <p className="card-s">Set the namespace and release name for the deployment.</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
            <div className="field">
              <label>Namespace</label>
              <input value={namespace} onChange={(e) => setNamespace(e.target.value)} />
            </div>
            <div className="field">
              <label>Release name</label>
              <input value={releaseName} onChange={(e) => setReleaseName(e.target.value)}
                     placeholder={repoUrl.split('/').pop() || 'my-app'} />
            </div>
            <div className="field">
              <label>Environment</label>
              <select value={env} onChange={(e) => setEnv(e.target.value)}>
                <option value="DEV">DEV</option>
                <option value="UAT">UAT</option>
                <option value="PROD">PROD</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <button className="btn" onClick={() => setStep(2)}>← Back</button>
            <button className="btn btn-primary" onClick={() => setStep(4)}>Continue →</button>
          </div>
        </div>
      )}

      {/* ======================= STEP 4: REVIEW ======================= */}
      {step === 4 && (
        <div className="card">
          <h2 className="card-h">Review &amp; confirm</h2>
          <p className="card-s">CloudPilot will register this application and trigger its first deploy.</p>
          <div style={{ background: '#fafbfc', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginBottom: 12 }}>
            <div className="row" style={{ margin: 0, marginBottom: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>Repository</span>
              <span style={{ fontWeight: 500 }}>{repoUrl} @ {branch}</span>
            </div>
            <div className="row" style={{ margin: 0, marginBottom: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>Repo access</span>
              <span style={{ fontWeight: 500 }}>
                {repoToken ? 'Token configured (private repo)' : 'No token (public repo)'}
              </span>
            </div>
            <div className="row" style={{ margin: 0, marginBottom: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>Cluster</span>
              <span style={{ fontWeight: 500 }}>
                {accounts.find((a) => a.id === parseInt(clusterId))?.account_ref ?? clusterId}
              </span>
            </div>
            <div className="row" style={{ margin: 0, marginBottom: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>Namespace / Release</span>
              <span style={{ fontWeight: 500 }}>{namespace} / {releaseName || repoUrl.split('/').pop()}</span>
            </div>
            <div className="row" style={{ margin: 0 }}>
              <span className="muted" style={{ fontSize: 12 }}>Environment</span>
              <span className={`tag tag-${env === 'PROD' ? 'red' : env === 'UAT' ? 'blue' : 'amber'}`}>{env}</span>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <button className="btn" onClick={() => setStep(3)}>← Back</button>
            <button className="btn btn-primary" onClick={onboard} disabled={saving || !canOnboard}>
              {saving ? 'Onboarding…' : 'Onboard application'}
            </button>
          </div>
        </div>
      )}

      {message && <div className="ok-box">{message}</div>}
      {error && <div className="error-text">{error}</div>}

      {/* ======================= PIPELINE RUNS ======================= */}
      <div className="row" style={{ marginTop: 32 }}>
        <div>
          <h2 className="card-h" style={{ margin: 0 }}>Pipeline runs</h2>
          <p className="card-s" style={{ margin: '2px 0 0' }}>Deploy history for every onboarded application.</p>
        </div>
      </div>

      <div className="pipeline-stats">
        <div className="pipe-stat">
          <div className="pipe-stat-l">Deploys this week</div>
          <div className="pipe-stat-v">{stats?.deploys ?? '—'}</div>
        </div>
        <div className="pipe-stat">
          <div className="pipe-stat-l">Success rate</div>
          <div className="pipe-stat-v" style={{ color: '#16a34a' }}>
            {stats ? `${stats.success_rate.toFixed(1)}%` : '—'}
          </div>
        </div>
        <div className="pipe-stat">
          <div className="pipe-stat-l">Failed deploys</div>
          <div className="pipe-stat-v" style={{ color: '#dc2626' }}>{stats?.failed ?? '—'}</div>
        </div>
        <div className="pipe-stat">
          <div className="pipe-stat-l">Applications</div>
          <div className="pipe-stat-v">{apps.length}</div>
        </div>
      </div>

      {/* ======================= FILTERS ======================= */}
      <div className="filters">
        <div className="filter-group" style={{ flex: 1, minWidth: 220 }}>
          <label>Search</label>
          <input
            placeholder="Repo, release, namespace, cluster…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>
        <div className="filter-group">
          <label>Provider</label>
          {providerFilter && <CloudIcon provider={providerFilter} size={16} />}
          <CloudSelect
            value={providerFilter}
            onChange={(value) => setProviderFilter(value)}
            placeholder="All providers"
            options={[
              { value: 'aws', label: 'AWS', provider: 'aws' },
              { value: 'gcp', label: 'GCP', provider: 'gcp' },
              { value: 'azure', label: 'Azure', provider: 'azure' },
              { value: 'databricks', label: 'Databricks', provider: 'databricks' },
              { value: 'oracle', label: 'Oracle Cloud', provider: 'oracle' },
              { value: 'ibm', label: 'IBM Cloud', provider: 'ibm' },
              { value: 'alibaba', label: 'Alibaba Cloud', provider: 'alibaba' },
            ]}
          />
        </div>
        <div className="filter-group">
          <label>Env</label>
          <select value={envFilter} onChange={(e) => setEnvFilter(e.target.value)}>
            <option value="">All envs</option>
            <option value="DEV">DEV</option>
            <option value="UAT">UAT</option>
            <option value="PROD">PROD</option>
          </select>
        </div>
        <div className="filter-group">
          <label>Last run</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">Any status</option>
            <option value="ok">Success</option>
            <option value="fail">Failed</option>
            <option value="running">Running</option>
            <option value="queued">Queued</option>
            <option value="none">No runs</option>
          </select>
        </div>
        {hasFilters && (
          <button className="btn btn-sm" type="button" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {apps.length > 0 && (
        <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Showing {filteredApps.length} of {apps.length} application{apps.length === 1 ? '' : 's'}
        </p>
      )}

      {apps.length === 0 && (
        <div className="card">
          <p className="muted" style={{ fontSize: 13 }}>
            No applications onboarded yet. Complete the wizard above to add one.
          </p>
        </div>
      )}

      {apps.length > 0 && filteredApps.length === 0 && (
        <div className="card">
          <p className="muted" style={{ fontSize: 13 }}>
            No applications match the current filters.
          </p>
        </div>
      )}

      {filteredApps.map((app) => {
        const runs = runsByApp[app.id] ?? [];
        const latest = runs[0];
        const cluster = findAccount(app.cluster_id);
        const hasToken = Boolean(app.has_repo_token);
        const busy = Boolean(tokenBusy[app.id]);
        const msg = tokenMsg[app.id];

        return (
          <div className="pipeline-card" key={app.id}>
            <div className="pipeline-h" onClick={() => setOpen((o) => ({ ...o, [app.id]: !o[app.id] }))}>
              <div className="pipeline-repo">
                {app.repo_url.split('/').slice(-2).join('/')}{' '}
                <span className="tag tag-gray">{app.branch}</span>
                {hasToken && (
                  <span className="tag tag-green" style={{ marginLeft: 6 }} title="Repository access token configured">
                    🔒 token
                  </span>
                )}
              </div>
              <div className="pipeline-meta">
                <strong>{app.release_name}</strong>
                <br />
                {app.namespace}
              </div>
              <div className="pipeline-meta">
                <strong style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {cluster && <CloudIcon provider={cluster.provider} size={14} />}
                  {cluster?.account_ref ?? `cluster ${app.cluster_id}`}
                </strong>
                <br />
                {cluster?.provider?.toUpperCase() ?? ''} · {app.env}
              </div>
              <div className="pipeline-meta">
                {latest ? (
                  <>
                    <span className={`tag tag-${latest.status === 'ok' ? 'green' : latest.status === 'fail' ? 'red' : latest.status === 'running' ? 'blue' : 'gray'}`}>
                      {latest.status}
                    </span>
                    <br />
                    {latest.commit_sha}
                  </>
                ) : (
                  <span className="muted">no runs</span>
                )}
              </div>
              <div className="pipeline-meta">
                {runs.length} run{runs.length === 1 ? '' : 's'}
              </div>
              <div className="pipeline-meta" style={{ textAlign: 'right', color: '#64748b', fontSize: 12 }}>
                {open[app.id] ? 'hide ‹' : 'details ›'}
              </div>
            </div>

            {open[app.id] && (
              <div className="pipeline-body open">
                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                  <button className="btn btn-sm btn-primary" onClick={() => deploy(app.id)}>
                    Trigger deploy
                  </button>
                </div>

                {/* NEW — credentials section */}
                <div style={{ marginTop: 20, padding: 16, border: '1px solid #e5e7eb', borderRadius: 8, background: '#fafbfc' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div>
                      <strong style={{ fontSize: 13 }}>Repository credentials</strong>
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {hasToken
                          ? 'A token is stored. It is used for every clone — including retries — and never returned to the browser.'
                          : 'No token stored. Cloning will fail if the repository is private.'}
                      </div>
                    </div>
                    <span className={`tag tag-${hasToken ? 'green' : 'gray'}`}>
                      {hasToken ? 'configured' : 'not set'}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <div className="field" style={{ margin: 0, flex: 1 }}>
                      <label style={{ fontSize: 12 }}>
                        {hasToken ? 'Replace token' : 'Add token'}
                      </label>
                      <input
                        type="password"
                        autoComplete="off"
                        placeholder="ghp_… / glpat-… / app-password"
                        value={tokenDraft[app.id] ?? ''}
                        onChange={(e) =>
                          setTokenDraft((d) => ({ ...d, [app.id]: e.target.value }))
                        }
                        disabled={busy}
                      />
                    </div>
                    <button
                      className="btn btn-sm btn-primary"
                      type="button"
                      disabled={busy || !(tokenDraft[app.id] ?? '').trim()}
                      onClick={() => saveToken(app.id, (tokenDraft[app.id] ?? '').trim())}
                    >
                      {busy ? 'Saving…' : hasToken ? 'Update' : 'Save'}
                    </button>
                    {hasToken && (
                      <button
                        className="btn btn-sm"
                        type="button"
                        disabled={busy}
                        onClick={() => saveToken(app.id, '')}
                        title="Remove the stored token. Cloning will use no auth."
                      >
                        Clear
                      </button>
                    )}
                  </div>

                  {msg && (
                    <div
                      className={msg.kind === 'ok' ? 'ok-box' : 'error-text'}
                      style={{ marginTop: 8, fontSize: 12 }}
                    >
                      {msg.text}
                    </div>
                  )}
                </div>

                {runs.length === 0 ? (
                  <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
                    No pipeline runs yet for this application.
                  </p>
                ) : (
                  <div className="pipeline-steps">
                    {runs.map((run) => (
                      <div className="pipe-step" key={run.id}>
                        <div className={`pipe-step-icon ${run.status === 'ok' ? 'ok' : run.status === 'fail' ? 'fail' : 'running'}`}>
                          {run.status === 'ok' ? '✓' : run.status === 'fail' ? '✕' : '●'}
                        </div>
                        <div style={{ fontSize: 13 }}>
                          <strong>Run {run.id}</strong> · {run.commit_sha}
                          <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                            image: {run.image}
                          </div>
                        </div>
                        <div style={{ fontSize: 11.5, color: '#64748b' }}>
                          {run.started_at ? new Date(run.started_at).toLocaleString() : ''}
                        </div>
                        <div style={{ fontSize: 11.5, color: '#64748b' }}>{run.status}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <Pagination
              page={appPage}
              pages={appPages}
              total={appTotal}
              limit={10}
              onChange={setAppPage}
            />
          </div>
        );
      })}
    </>
  );
}