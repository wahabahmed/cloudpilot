import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { Pagination } from '../components/Pagination';

const REQUEST_STATUSES = [
  'awaiting_approval',
  'queued',
  'planning',
  'applying',
  'applied',
  'completed',
  'failed',
  'rejected',
  'import_queued',
  'imported',
  'planned',
] as const;

const STATUS_COLOR: Record<string, string> = {
  awaiting_approval: 'amber',
  queued: 'blue',
  planning: 'blue',
  planned: 'amber',
  applying: 'blue',
  applied: 'green',
  completed: 'green',
  rejected: 'gray',
  failed: 'red',
  import_queued: 'blue',
  imported: 'green',
};

const DEFAULT_STATE = 'awaiting_approval';

interface RequestRow {
  id: number;
  status: string;
  env: string;
  nlp_text: string;
  account_id: number;
  workflow_id: number | null;
  current_step: number;
  total_steps: number;
  approvals_log: { step: number; user_id: number; email: string; at: string }[];
  requested_by: number | null;
  requested_by_email: string | null;
  approved_by: number | null;
  approved_by_email: string | null;
  additions: number;
  changes: number;
  destructions: number;
  created_at: string;
  completed_at: string | null;
}

export function Requests() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const rawState = searchParams.get('state');
  const state =
    rawState === null ? DEFAULT_STATE :
    rawState === 'all' ? '' :
    rawState;

  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const limit = Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10) || 20);

  const [mineOnly, setMineOnly] = useState(false);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);

  const [detail, setDetail] = useState<any | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const isAdmin = user?.role === 'admin';

  const setParams = (next: Record<string, string | null>) => {
    const merged = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(next)) {
      if (v === null) merged.delete(k);
      else merged.set(k, v);
    }
    setSearchParams(merged, { replace: false });
  };

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.listRequests(user.tenant_id, {
        status: state || undefined,
        requested_by: isAdmin && mineOnly ? user.user_id : undefined,
        page,
        limit,
      });
      setRequests(r.items);
      setTotal(r.total);
      setPages(r.pages);
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : (e?.message ?? String(e));
      const status = e instanceof ApiError ? e.status : undefined;
      setError({ message: msg, status });
      setRequests([]);
      setTotal(0);
      setPages(1);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, state, page, limit, mineOnly]);

  if (!user) return null;

  const openDetail = async (rid: number) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const d = await api.getRequest(rid);
      setDetail(d);
    } catch (e: any) {
      setError({ message: e.message, status: e instanceof ApiError ? e.status : undefined });
    } finally {
      setDetailLoading(false);
    }
  };

  const approve = async (rid: number) => {
    if (busy[rid]) return;
    setBusy((b) => ({ ...b, [rid]: true }));
    setError(null);
    setMessage('');
    try {
      await api.approveRequest(rid);
      setMessage(`Request ${rid} approved. Next step will start shortly.`);
      setTimeout(refresh, 800);
      if (detail?.id === rid) openDetail(rid);
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : (e?.message ?? String(e));
      setError({ message: msg, status: e instanceof ApiError ? e.status : undefined });
    } finally {
      setBusy((b) => {
        const n = { ...b };
        delete n[rid];
        return n;
      });
    }
  };

  const reject = async (rid: number) => {
    if (busy[rid]) return;
    const reason = window.prompt('Reason for rejection (optional):');
    if (reason === null) return;
    setBusy((b) => ({ ...b, [rid]: true }));
    setError(null);
    setMessage('');
    try {
      await api.rejectRequest(rid, reason);
      setMessage(`Request ${rid} rejected.`);
      setTimeout(refresh, 500);
      if (detail?.id === rid) openDetail(rid);
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : (e?.message ?? String(e));
      setError({ message: msg, status: e instanceof ApiError ? e.status : undefined });
    } finally {
      setBusy((b) => {
        const n = { ...b };
        delete n[rid];
        return n;
      });
    }
  };

  const cardTitle =
    state === 'awaiting_approval' ? 'Awaiting approval' :
    state === 'applying'          ? 'In flight' :
    state === 'completed'         ? 'Completed' :
    state === 'failed'            ? 'Failed' :
    state ? `${state.replace(/_/g, ' ')}` :
            'All requests';

  return (
    <>
      <div className="row">
        <div>
          <h1 className="h1">Requests</h1>
          <p className="sub">
            {isAdmin
              ? 'Provisioning requests across the tenant. Each request follows its workflow step by step.'
              : 'Your provisioning requests.'}
          </p>
        </div>
        <button className="btn btn-sm" type="button" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="filters">
        <div className="filter-group">
          <label>State</label>
          <select value={state || 'all'} onChange={(e) => setParams({ state: e.target.value || 'all', page: '1' })}>
            <option value="all">All states</option>
            {REQUEST_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label>Page size</label>
          <select value={limit} onChange={(e) => setParams({ limit: e.target.value, page: '1' })}>
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={50}>50</option>
          </select>
        </div>

        {isAdmin && (
          <div className="filter-group">
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={mineOnly}
                onChange={(e) => { setMineOnly(e.target.checked); setParams({ page: '1' }); }}
              />
              Only mine
            </label>
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-h">{cardTitle} ({total})</h2>

        {error ? (
          <div className="error-text" style={{ marginBottom: 8 }}>
            <strong>{error.status ? `HTTP ${error.status}: ` : ''}</strong>
            {error.message}
            <button className="btn btn-sm" type="button" style={{ marginLeft: 8 }} onClick={refresh}>
              Retry
            </button>
          </div>
        ) : loading ? (
          <p className="muted" style={{ fontSize: 13 }}>Loading…</p>
        ) : requests.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            {state === DEFAULT_STATE
              ? <>No requests are currently awaiting approval. <a href="?state=all">Show all states</a>.</>
              : state
              ? <>No requests in state <code>{state}</code>.</>
              : <>No requests yet.</>}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Requested by</th>
                  <th>Env</th>
                  <th>Status</th>
                  <th>Step</th>
                  <th>+/~/-</th>
                  <th>Created</th>
                  <th style={{ width: 200 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => {
                  const b = Boolean(busy[r.id]);
                  const canAct = isAdmin && r.status === 'awaiting_approval';
                  return (
                    <tr key={r.id} onClick={() => openDetail(r.id)} style={{ cursor: 'pointer' }}>
                      <td>{r.nlp_text?.slice(0, 60) ?? '—'}…</td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {r.requested_by_email ?? `#${r.requested_by ?? '—'}`}
                      </td>
                      <td>
                        <span className={`tag tag-${r.env === 'PROD' ? 'red' : r.env === 'UAT' ? 'blue' : 'amber'}`}>
                          {r.env}
                        </span>
                      </td>
                      <td>
                        <span className={`tag tag-${STATUS_COLOR[r.status] ?? 'gray'}`}>
                          {r.status}
                        </span>
                      </td>
                      <td className="muted" style={{ fontSize: 11 }}>
                        {r.total_steps > 0
                          ? `${Math.min(r.current_step + 1, r.total_steps)}/${r.total_steps}`
                          : '—'}
                      </td>
                      <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        <span className="tag tag-green">+{r.additions ?? 0}</span>{' '}
                        <span className="tag tag-amber">~{r.changes ?? 0}</span>{' '}
                        <span className="tag tag-red">-{r.destructions ?? 0}</span>
                      </td>
                      <td className="muted" style={{ fontSize: 11 }}>
                        {r.created_at ? new Date(r.created_at).toLocaleString() : '—'}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {canAct ? (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              className={`btn btn-sm btn-primary ${b ? 'loading' : ''}`}
                              disabled={b}
                              onClick={() => approve(r.id)}
                            >
                              {b ? '' : 'Approve'}
                            </button>
                            <button
                              className="btn btn-sm btn-danger"
                              disabled={b}
                              onClick={() => reject(r.id)}
                            >
                              Reject
                            </button>
                          </div>
                        ) : (
                          <span className="muted" style={{ fontSize: 11 }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <Pagination
          page={page}
          pages={pages}
          total={total}
          limit={limit}
          onChange={(p) => setParams({ page: String(p) })}
        />

        {message && <div className="ok-box" style={{ marginTop: 12 }}>{message}</div>}
      </div>

      {/* Detail drawer */}
      {(detail || detailLoading) && (
        <div
          style={{
            position: 'fixed',
            top: 0, right: 0, bottom: 0,
            width: 'min(600px, 100vw)',
            background: '#fff',
            borderLeft: '1px solid #e5e7eb',
            boxShadow: '-2px 0 20px rgba(0,0,0,0.08)',
            zIndex: 50,
            overflowY: 'auto',
            padding: 24,
          }}
        >
          <div className="row" style={{ margin: 0, marginBottom: 16 }}>
            <h2 className="card-h" style={{ margin: 0 }}>
              Request #{detail?.id ?? '…'}
            </h2>
            <button className="btn btn-sm" type="button" onClick={() => setDetail(null)}>
              Close
            </button>
          </div>

          {detailLoading ? (
            <p className="muted">Loading…</p>
          ) : detail && (
            <>
              <div style={{ marginBottom: 16 }}>
                <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Status</div>
                <span className={`tag tag-${STATUS_COLOR[detail.status] ?? 'gray'}`}>{detail.status}</span>
              </div>

              <div style={{ marginBottom: 16 }}>
                <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Progress</div>
                <div style={{ fontSize: 13 }}>
                  Step {Math.min(detail.current_step + 1, detail.total_steps)} of {detail.total_steps}
                </div>
                <div style={{ height: 6, background: '#e5e7eb', borderRadius: 999, marginTop: 6, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${detail.total_steps > 0 ? Math.min(100, (detail.current_step / detail.total_steps) * 100) : 0}%`,
                      background: '#4f46e5',
                      transition: 'width 0.3s',
                    }}
                  />
                </div>
              </div>

              {detail.workflow_steps && detail.workflow_steps.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>Workflow</div>
                  <ol style={{ paddingLeft: 18, margin: 0, fontSize: 13 }}>
                    {detail.workflow_steps.map((s: any, i: number) => {
                      const done = i < detail.current_step;
                      const current = i === detail.current_step;
                      return (
                        <li
                          key={i}
                          style={{
                            marginBottom: 6,
                            color: done ? '#16a34a' : current ? '#0f172a' : '#94a3b8',
                            fontWeight: current ? 600 : 400,
                          }}
                        >
                          {s.type}
                          {s.type === 'approval' && s.approvers?.length > 0 && (
                            <span className="muted" style={{ fontSize: 11 }}> ({s.approvers.join(', ')})</span>
                          )}
                          {done && ' ✓'}
                          {current && ' ← current'}
                        </li>
                      );
                    })}
                  </ol>
                </div>
              )}

              <div style={{ marginBottom: 16 }}>
                <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Request</div>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{detail.nlp_text}</div>
              </div>

              {detail.approvals_log && detail.approvals_log.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Approvals</div>
                  <table>
                    <thead><tr><th>Step</th><th>Approver</th><th>When</th></tr></thead>
                    <tbody>
                      {detail.approvals_log.map((a: any, i: number) => (
                        <tr key={i}>
                          <td>{a.step + 1}</td>
                          <td>{a.email}</td>
                          <td className="muted" style={{ fontSize: 11 }}>
                            {new Date(a.at).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {detail.plan && (
                <div style={{ marginBottom: 16 }}>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Terraform plan</div>
                  <pre style={{ maxHeight: 300, overflow: 'auto', fontSize: 11, lineHeight: 1.4, background: '#f8fafc', padding: 10, borderRadius: 6 }}>
                    {detail.plan}
                  </pre>
                </div>
              )}

              {detail.status === 'awaiting_approval' && isAdmin && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary" onClick={() => approve(detail.id)}>
                    Approve
                  </button>
                  <button className="btn btn-danger" onClick={() => reject(detail.id)}>
                    Reject
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}