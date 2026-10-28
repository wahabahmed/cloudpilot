import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';

export function Import() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountId, setAccountId] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [resources, setResources] = useState<any[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');

  useEffect(() => {
    if (!user) return;
    api.listAccounts(user.tenant_id, { page: 1, limit: 100 })
      .then((res) => {
        setAccounts(res.items);
        const preselect = searchParams.get('account');
        if (preselect) setAccountId(preselect);
      })
      .catch(() => {});
  }, [user, searchParams]);

  if (!user) return null;
  if (user.role !== 'admin') {
    return <div className="card"><p className="muted">Admin only.</p></div>;
  }

  // Only accounts with a native ID can be discovered / imported.
  const importableAccounts = accounts.filter((a) => a.cloud_account_id);

  const discover = async () => {
    if (!accountId) return;
    setLoading(true); setError(''); setMessage(''); setPreview('');
    setResources([]); setSelected({});
    try {
      const res = await api.discoverImportable(parseInt(accountId), region);
      setResources(res.resources);
      setMessage(`Found ${res.count} ${res.provider.toUpperCase()} resources.`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const startImport = async () => {
    const ids = Object.keys(selected).filter((k) => selected[k]);
    if (!ids.length) return;
    setLoading(true); setError(''); setMessage('');
    try {
      const res = await api.startImport(parseInt(accountId), ids, region);
      setMessage(
        `Import queued: ${res.resource_count} resources (request ${res.request_id}).` +
        (res.skipped_already_imported > 0
          ? ` Skipped ${res.skipped_already_imported} already-imported.`
          : '')
      );
      setPreview(res.hcl_preview);
      setSelected({});
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const selectAll = () => {
    const all: Record<string, boolean> = {};
    resources.forEach((r) => { all[r.id] = true; });
    setSelected(all);
  };

  return (
    <>
      <div className="row">
        <div>
          <h1 className="h1">Import existing resources</h1>
          <p className="sub">
            Bring resources that already exist in your cloud sub-account under Terraform management.
          </p>
        </div>
      </div>

      <div className="card" style={{ borderLeft: '3px solid #dc2626' }}>
        <strong style={{ color: '#991b1b', fontSize: 13 }}>Before you import</strong>
        <ul className="muted" style={{ fontSize: 12, marginTop: 6, paddingLeft: 18 }}>
          <li>
            If these resources are currently managed by <em>your own</em> Terraform, run
            <code style={{ margin: '0 4px' }}>terraform state rm &lt;resource&gt;</code>
            first. CloudPilot will create a new state file that owns them — having two states
            both claim the same resource will cause failures and unwanted changes.
          </li>
          <li>
            CloudPilot runs <code>terraform import</code> as the target sub-account. The root
            credential must be able to assume the sub-account role.
          </li>
          <li>
            Only resources whose type is mapped in <code>TF_TYPE_MAP</code> will be imported.
            Others will be shown but skipped.
          </li>
        </ul>
      </div>

      <div className="card">
        <h2 className="card-h">1. Choose account and region</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 12 }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Account</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">— pick an account —</option>
              {importableAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.account_ref} · {a.provider.toUpperCase()} · {a.env} · {a.cloud_account_id}
                </option>
              ))}
              {importableAccounts.length === 0 && (
                <option value="" disabled>
                  No accounts with a native ID yet — register one in Cloud Setup
                </option>
              )}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Region</label>
            <input value={region} onChange={(e) => setRegion(e.target.value)} />
          </div>
          <div style={{ alignSelf: 'end' }}>
            <button className="btn btn-primary" onClick={discover}
                    disabled={loading || !accountId}>
              {loading ? 'Discovering…' : 'Discover'}
            </button>
          </div>
        </div>
      </div>

      {resources.length > 0 && (
        <div className="card">
          <div className="row" style={{ margin: 0, marginBottom: 12 }}>
            <h2 className="card-h" style={{ margin: 0 }}>
              2. Select resources ({resources.length} found)
            </h2>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-sm" onClick={selectAll}>Select all</button>
              <button className="btn btn-sm" onClick={() => setSelected({})}>Clear</button>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th style={{ width: 40 }}></th><th>Type</th><th>ID</th><th>Name</th><th>Region</th></tr>
              </thead>
              <tbody>
                {resources.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <input type="checkbox"
                             checked={!!selected[r.id]}
                             onChange={() => setSelected({ ...selected, [r.id]: !selected[r.id] })} />
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>{r.type}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{r.id}</td>
                    <td>{r.name}</td>
                    <td className="muted">{r.region}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-primary" onClick={startImport} disabled={loading}>
              {loading
                ? 'Generating HCL…'
                : `Import ${Object.values(selected).filter(Boolean).length} selected`}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              Terraform generates HCL for each resource, DeepSeek cleans it up, then a
              queued job runs <code>terraform apply</code> to adopt them into a new state.
            </span>
          </div>
        </div>
      )}

      {message && <div className="ok-box">{message}</div>}
      {error && <div className="error-text">{error}</div>}

      {preview && (
        <div className="card">
          <h2 className="card-h">Generated HCL preview</h2>
          <p className="card-s">
            This was refined by DeepSeek and will be used for the import. Review it in
            Dashboard → pending approvals before approving.
          </p>
          <pre style={{ maxHeight: 400, overflow: 'auto', fontSize: 11, lineHeight: 1.5 }}>
            {preview}
          </pre>
        </div>
      )}
    </>
  );
}