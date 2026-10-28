import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { CloudIcon } from '../components/CloudIcon';
import { CloudSelect } from '../components/CloudSelect';

const RANGES = [30, 90, 180, 365] as const;

type TeamRow = {
  team_id: number | null;
  team_name: string;
  user_count: number;
  account_count: number;
  budget: number;
  cost: number;
  utilization: number | null;
};

type AccountRow = {
  account_id: number;
  provider: string;
  account_ref: string;
  env: string;
  cost: number;
};

type Recommendation = {
  id: number;
  account_id: number;
  resource_id: string;
  rule: string;
  finding: string;
  monthly_savings: number;
  effort: string;
  status: string;
  created_at: string | null;
};

export function Finance() {
  const { user } = useAuth();
  const [days, setDays] = useState<number>(30);
  const [env, setEnv] = useState<string>('');
  const [providerFilter, setProviderFilter] = useState('');
  const [teamFilter, setTeamFilter] = useState<string>('');
  const [accountFilter, setAccountFilter] = useState<string>('');

  const [total, setTotal] = useState<number>(0);
  const [byAccount, setByAccount] = useState<AccountRow[]>([]);
  const [trend, setTrend] = useState<{ date: string; amount: number }[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [accountTeams, setAccountTeams] = useState<Record<number, { id: number; name: string }[]>>({});
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dismissing, setDismissing] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    setError('');
    Promise.all([
      api.tenantFinance(user.tenant_id, days, env || undefined, providerFilter || undefined)
        .catch((e) => { console.warn('finance/resources:', e?.message); return { total_cost: 0, accounts: [] as AccountRow[] }; }),
      api.costTrend(user.tenant_id, days)
        .catch((e) => { console.warn('finance/trend:', e?.message); return []; }),
      api.financeSummary(user.tenant_id, days)
        .catch((e) => { console.warn('finance/summary:', e?.message); return { tenant_id: user.tenant_id, period_days: days, teams: [] as TeamRow[] }; }),
      api.listAccountTeams(user.tenant_id)
        .catch((e) => { console.warn('account-teams:', e?.message); return {} as Record<string, { id: number; name: string }[]>; }),
      api.listRecommendations(user.tenant_id, 'open')
        .catch((e) => { console.warn('finance/recommendations:', e?.message); return [] as Recommendation[]; }),
    ]).then(([f, t, s, at, r]) => {
      setTotal((f as any).total_cost ?? 0);
      setByAccount((f as any).accounts ?? []);
      setTrend((t as any[]) ?? []);
      setTeams((s as any).teams ?? []);
      const norm: Record<number, { id: number; name: string }[]> = {};
      Object.entries(at as Record<string, { id: number; name: string }[]>).forEach(([k, v]) => {
        norm[Number(k)] = v;
      });
      setAccountTeams(norm);
      setRecs((r as Recommendation[]) ?? []);
    }).catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [user, days, env, providerFilter]);

  const teamOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { value: string; label: string }[] = [];
    for (const t of teams) {
      const key = t.team_id === null ? '__unassigned__' : String(t.team_id);
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ value: key, label: t.team_name });
      }
    }
    return out;
  }, [teams]);

  const accountOptions = useMemo(() => {
    return byAccount
      .map((a) => ({
        value: String(a.account_id),
        label: `${a.account_ref} · ${a.provider.toUpperCase()} · ${a.env}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [byAccount]);

  const filteredByAccount = useMemo(() => {
    return byAccount.filter((a) => {
      if (accountFilter && String(a.account_id) !== accountFilter) return false;
      if (!teamFilter) return true;
      const t = accountTeams[a.account_id] ?? [];
      if (teamFilter === '__unassigned__') return t.length === 0;
      return t.some((x) => String(x.id) === teamFilter);
    });
  }, [byAccount, accountFilter, teamFilter, accountTeams]);

  const filteredTeams = useMemo(() => {
    return teams.filter((t) => {
      if (!teamFilter) return true;
      const key = t.team_id === null ? '__unassigned__' : String(t.team_id);
      return key === teamFilter;
    });
  }, [teams, teamFilter]);

  const filteredRecs = useMemo(() => {
    return recs.filter((r) => {
      if (accountFilter && String(r.account_id) !== accountFilter) return false;
      if (!teamFilter) return true;
      const teamsForAcct = accountTeams[r.account_id] ?? [];
      if (teamFilter === '__unassigned__') return teamsForAcct.length === 0;
      return teamsForAcct.some((x) => String(x.id) === teamFilter);
    });
  }, [recs, accountFilter, teamFilter, accountTeams]);

  if (!user) return null;

  const hasFilters = Boolean(env || providerFilter || teamFilter || accountFilter);
  const clearFilters = () => {
    setEnv('');
    setProviderFilter('');
    setTeamFilter('');
    setAccountFilter('');
  };

  const visibleAccountCost = filteredByAccount.reduce((a, r) => a + r.cost, 0);
  const visibleTeamCost = filteredTeams.reduce((a, r) => a + r.cost, 0);
  const visibleTeamBudget = filteredTeams.reduce((a, r) => a + r.budget, 0);
  const potentialSavings = filteredRecs.reduce((a, r) => a + r.monthly_savings, 0);

  const displayTotal = teamFilter ? visibleTeamCost
                    : accountFilter ? visibleAccountCost
                    : total;

  const dismissRec = async (rid: number) => {
    if (dismissing[rid]) return;
    setDismissing((d) => ({ ...d, [rid]: true }));
    try {
      await api.dismissRecommendation(user.tenant_id, rid, 'dismissed');
      setRecs((rs) => rs.filter((r) => r.id !== rid));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDismissing((d) => {
        const n = { ...d };
        delete n[rid];
        return n;
      });
    }
  };

  return (
    <>
      <div className="row">
        <div>
          <h1 className="h1">Finance</h1>
          <p className="sub">Cost visibility across all accounts you can see.</p>
        </div>
      </div>

      <div className="filters">
        <div className="filter-group">
          <label>Provider</label>
          <CloudSelect
            value={providerFilter}
            onChange={(value) => setProviderFilter(value)}
            options={[
              { value: 'aws', label: 'AWS', provider: 'aws' },
              { value: 'gcp', label: 'GCP', provider: 'gcp' },
              { value: 'azure', label: 'Azure', provider: 'azure' },
              { value: 'databricks', label: 'Databricks', provider: 'databricks' },
              { value: 'oracle', label: 'Oracle Cloud', provider: 'oracle' },
              { value: 'ibm', label: 'IBM Cloud', provider: 'ibm' },
              { value: 'alibaba', label: 'Alibaba Cloud', provider: 'alibaba' },
            ]}
            placeholder="All providers"
          />
        </div>

        <div className="filter-group">
          <label>Environment</label>
          <select value={env} onChange={(e) => setEnv(e.target.value)}>
            <option value="">All envs</option>
            <option value="DEV">DEV</option>
            <option value="UAT">UAT</option>
            <option value="PROD">PROD</option>
          </select>
        </div>

        <div className="filter-group">
          <label>Team</label>
          <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
            <option value="">All teams</option>
            {teamOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label>Account</label>
          <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
            <option value="">All accounts</option>
            {accountOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {hasFilters && (
          <button className="btn btn-sm" type="button" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      <div className="grid-4">
        <div className="kpi">
          <div className="kpi-l">Total spend</div>
          <div className="kpi-v">${displayTotal.toFixed(0)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-l">Potential savings</div>
          <div className="kpi-v" style={{ color: '#16a34a' }}>
            ${potentialSavings.toFixed(0)}/mo
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-l">Accounts</div>
          <div className="kpi-v">{accountFilter ? 1 : filteredByAccount.length}</div>
        </div>
        <div className="kpi">
          <div className="kpi-l">Period</div>
          <div className="kpi-v" style={{ fontSize: 18 }}>{days} days</div>
        </div>
      </div>

      <div className="card chart-card">
        <div className="chart-header">
          <div>
            <h2 className="card-h" style={{ margin: 0 }}>Spend history</h2>
            <p className="card-s" style={{ margin: '2px 0 0' }}>
              Daily cost across visible accounts{hasFilters ? ' (filtered)' : ''}.
            </p>
          </div>
          <div className="chart-tabs">
            {RANGES.map((r) => (
              <button
                key={r}
                className={`chart-tab ${days === r ? 'active' : ''}`}
                onClick={() => setDays(r)}
              >
                {r === 365 ? '1y' : `${r}d`}
              </button>
            ))}
          </div>
        </div>
        {loading ? (
          <p className="muted" style={{ fontSize: 13 }}>Loading…</p>
        ) : trend.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            No cost data yet. Run the cost ingestion job to populate it.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={trend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} />
              <YAxis stroke="#94a3b8" fontSize={11} />
              <Tooltip />
              <Line type="monotone" dataKey="amount" stroke="#4f46e5" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ================= COST OPTIMIZATION ================= */}
      <div className="card">
        <div className="row" style={{ margin: 0, marginBottom: 12 }}>
          <div>
            <h2 className="card-h" style={{ margin: 0 }}>Cost optimization</h2>
            <p className="card-s" style={{ margin: '2px 0 0' }}>
              Findings from the nightly analyzer. Savings are conservative estimates.
            </p>
          </div>
          {filteredRecs.length > 0 && (
            <div style={{ textAlign: 'right' }}>
              <div className="muted" style={{ fontSize: 11 }}>Potential savings</div>
              <div style={{ fontSize: 22, fontWeight: 600, color: '#16a34a' }}>
                ${potentialSavings.toFixed(0)}/mo
              </div>
            </div>
          )}
        </div>

        {loading ? (
          <p className="muted" style={{ fontSize: 13 }}>Loading…</p>
        ) : filteredRecs.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            {hasFilters
              ? 'No recommendations match the current filters.'
              : 'No open recommendations. The analyzer runs nightly after cost ingestion.'}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Finding</th>
                  <th>Rule</th>
                  <th>$/mo</th>
                  <th>Effort</th>
                  <th style={{ width: 1 }}></th>
                </tr>
              </thead>
              <tbody>
                {filteredRecs.map((r) => {
                  const busy = Boolean(dismissing[r.id]);
                  return (
                    <tr key={r.id}>
                      <td style={{ fontSize: 12 }}>{r.finding}</td>
                      <td>
                        <code style={{ fontSize: 11 }}>{r.rule}</code>
                      </td>
                      <td style={{ color: '#16a34a', fontWeight: 500, whiteSpace: 'nowrap' }}>
                        ${r.monthly_savings.toFixed(2)}
                      </td>
                      <td>
                        <span className={`tag tag-${r.effort === 'low' ? 'green' : r.effort === 'high' ? 'red' : 'amber'}`}>
                          {r.effort}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn btn-sm"
                          type="button"
                          disabled={busy}
                          onClick={() => dismissRec(r.id)}
                          title="Mark as dismissed — hides from this list until the analyzer runs again"
                        >
                          {busy ? '…' : 'Dismiss'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '1px solid #e5e7eb', fontWeight: 600 }}>
                  <td>Total</td>
                  <td>—</td>
                  <td style={{ color: '#16a34a' }}>${potentialSavings.toFixed(2)}</td>
                  <td>—</td>
                  <td>—</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-h">Spend by account</h2>
        <p className="card-s">
          Total cost per account in this period{hasFilters ? ' (filtered)' : ''}.
        </p>
        {loading ? (
          <p className="muted" style={{ fontSize: 13 }}>Loading…</p>
        ) : filteredByAccount.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            {hasFilters ? 'No accounts match the current filters.' : 'No accounts.'}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Account</th><th>Provider</th><th>Env</th><th>Cost</th></tr>
              </thead>
              <tbody>
                {filteredByAccount.map((a) => (
                  <tr key={a.account_id}>
                    <td>{a.account_ref}</td>
                    <td style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <CloudIcon provider={a.provider} size={14} />
                      {a.provider}
                    </td>
                    <td>
                      <span className={`tag tag-${a.env === 'PROD' ? 'red' : a.env === 'UAT' ? 'blue' : 'amber'}`}>
                        {a.env}
                      </span>
                    </td>
                    <td>${(a.cost ?? 0).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '1px solid #e5e7eb', fontWeight: 600 }}>
                  <td>Total</td>
                  <td>—</td>
                  <td>—</td>
                  <td>${visibleAccountCost.toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-h">Spend by team</h2>
        <p className="card-s">
          Cost rolled up through each team's attached accounts. Accounts not attached
          to any team appear under <b>Unassigned</b>.
        </p>
        {loading ? (
          <p className="muted" style={{ fontSize: 13 }}>Loading…</p>
        ) : filteredTeams.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            {hasFilters ? 'No teams match the current filters.' : 'No teams yet.'}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Team</th>
                  <th>Members</th>
                  <th>Accounts</th>
                  <th>Cost</th>
                  <th>Budget</th>
                  <th>Utilization</th>
                </tr>
              </thead>
              <tbody>
                {filteredTeams.map((t) => {
                  const util = t.utilization;
                  const tagClass =
                    util === null ? 'gray'
                    : util > 100 ? 'red'
                    : util > 80  ? 'amber'
                    :              'green';
                  return (
                    <tr key={t.team_id ?? 'unassigned'}>
                      <td>
                        {t.team_name}
                        {t.team_id === null && (
                          <span className="tag tag-gray" style={{ marginLeft: 6 }}>
                            unassigned
                          </span>
                        )}
                      </td>
                      <td>{t.user_count}</td>
                      <td>{t.account_count}</td>
                      <td>${t.cost.toFixed(2)}</td>
                      <td>{t.budget > 0 ? `$${t.budget.toFixed(0)}` : '—'}</td>
                      <td>
                        {util === null ? (
                          '—'
                        ) : (
                          <span className={`tag tag-${tagClass}`}>{util.toFixed(0)}%</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '1px solid #e5e7eb', fontWeight: 600 }}>
                  <td>Total</td>
                  <td>—</td>
                  <td>{filteredTeams.reduce((a, r) => a + r.account_count, 0)}</td>
                  <td>${visibleTeamCost.toFixed(2)}</td>
                  <td>{visibleTeamBudget > 0 ? `$${visibleTeamBudget.toFixed(0)}` : '—'}</td>
                  <td>—</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {error && <div className="error-text">{error}</div>}
    </>
  );
}