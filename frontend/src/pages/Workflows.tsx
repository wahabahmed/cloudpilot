import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';

const STEP_TYPES = [
  { value: 'approval', label: 'Approval', hint: 'Pause and wait for any of the listed approvers to click Approve' },
  { value: 'tf_plan', label: 'Terraform plan', hint: 'Run terraform plan; show what would change' },
  { value: 'tf_apply', label: 'Terraform apply', hint: 'Apply the most recent plan' },
  { value: 'custom_parameter', label: 'Custom parameter', hint: 'Write a value to SSM / Secret Manager / Key Vault' },
  { value: 'notify', label: 'Notify', hint: 'Send an email, Slack message, or webhook' },
];

interface Step {
  type: string;
  approvers?: string;
  timeout_hours?: number;
  channel?: string;
  message?: string;
  to?: string;
  webhook_url?: string;
  url?: string;
  name?: string;
  value?: string;
  provider?: string;
  vault_url?: string;
}

export function Workflows() {
  const { user } = useAuth();
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<boolean>(false);

  const [name, setName] = useState('');
  const [steps, setSteps] = useState<Step[]>([
    { type: 'tf_plan' },
    { type: 'approval', approvers: '', timeout_hours: 24 },
    { type: 'tf_apply' },
  ]);

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refresh = async () => {
    if (!user) return;
    try {
      const list = await api.listWorkflows(user.tenant_id);
      setWorkflows(list as any[]);
    } catch (e: any) {
      setError(e.message);
    }
  };

  useEffect(() => { refresh(); }, [user]);

  if (!user) return null;
  const isAdmin = user.role === 'admin';

  const addStep = (type: string) => {
    const base: Step = { type };
    if (type === 'approval') base.timeout_hours = 24;
    if (type === 'notify') { base.channel = 'email'; base.message = ''; }
    if (type === 'custom_parameter') { base.name = ''; base.value = ''; }
    setSteps([...steps, base]);
  };

  const updateStep = (idx: number, patch: Partial<Step>) => {
    setSteps(steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const removeStep = (idx: number) => setSteps(steps.filter((_, i) => i !== idx));

  const moveStep = (idx: number, dir: -1 | 1) => {
    const next = [...steps];
    const target = idx + dir;
    if (target < 0 || target >= steps.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setSteps(next);
  };

  const resetBuilder = () => {
    setName('');
    setSteps([
      { type: 'tf_plan' },
      { type: 'approval', approvers: '', timeout_hours: 24 },
      { type: 'tf_apply' },
    ]);
    setEditing(false);
    setSelected(null);
    setMessage('');
    setError('');
  };

  const loadIntoBuilder = (wf: any) => {
    setSelected(wf.id);
    setName(wf.name);
    setSteps(
      (wf.steps_json || []).map((s: any) => {
        const base: Step = { type: s.type };
        if (s.type === 'approval') {
          base.approvers = Array.isArray(s.approvers) ? s.approvers.join(', ') : (s.approvers ?? '');
          base.timeout_hours = s.timeout_hours ?? 24;
        }
        if (s.type === 'notify') {
          base.channel = s.channel ?? 'email';
          base.message = s.message ?? '';
          base.to = s.to ?? '';
          base.webhook_url = s.webhook_url ?? '';
          base.url = s.url ?? '';
        }
        if (s.type === 'custom_parameter') {
          base.provider = s.provider ?? '';
          base.name = s.name ?? '';
          base.value = s.value ?? '';
          base.vault_url = s.vault_url ?? '';
        }
        return base;
      })
    );
    setEditing(true);
    setMessage('');
    setError('');
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setMessage(''); setSaving(true);
    try {
      if (!name.trim()) throw new Error('name is required');
      if (steps.length === 0) throw new Error('at least one step is required');

      const json = steps.map((s) => {
        if (s.type === 'approval') {
          const approvers = String(s.approvers ?? '')
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
          return { type: 'approval', approvers, timeout_hours: Number(s.timeout_hours ?? 24) };
        }
        if (s.type === 'notify') {
          return {
            type: 'notify',
            channel: s.channel || 'email',
            message: s.message || '',
            to: s.to || undefined,
            webhook_url: s.webhook_url || undefined,
            url: s.url || undefined,
          };
        }
        if (s.type === 'custom_parameter') {
          return {
            type: 'custom_parameter',
            provider: s.provider || undefined,
            name: s.name || '',
            value: s.value || '',
            vault_url: s.vault_url || undefined,
          };
        }
        return { type: s.type };
      });

      if (selected) {
        await api.updateWorkflow(selected, name.trim(), json);
        setMessage(`Workflow "${name.trim()}" updated.`);
      } else {
        await api.createWorkflow(user.tenant_id, name.trim(), json);
        setMessage(`Workflow "${name.trim()}" created.`);
      }

      resetBuilder();
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="row">
        <div>
          <h1 className="h1">Workflows</h1>
          <p className="sub">
            A workflow is an ordered list of steps a request goes through. Multiple
            approval steps are supported; each must be cleared by one of its
            listed approvers before the request proceeds.
          </p>
        </div>
        {isAdmin && !editing && (
          <button className="btn btn-primary" onClick={() => setEditing(true)}>
            + New workflow
          </button>
        )}
      </div>

      <div className="grid-2">
        <div className="card">
          <h2 className="card-h">Definitions ({workflows.length})</h2>
          {workflows.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>No workflows yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Name</th><th>Steps</th><th></th></tr></thead>
                <tbody>
                  {workflows.map((wf) => (
                    <tr key={wf.id}>
                      <td>{wf.name}</td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {(wf.steps_json as any[])?.map((s) => s.type).join(' → ') ?? '—'}
                      </td>
                      <td>
                        <button className="btn btn-sm" onClick={() => loadIntoBuilder(wf)}>
                          {isAdmin ? 'Edit' : 'View'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="row" style={{ margin: 0, marginBottom: 12 }}>
            <h2 className="card-h" style={{ margin: 0 }}>
              {editing ? (selected ? 'Edit workflow' : 'New workflow') : 'Step library'}
            </h2>
            {editing && <button className="btn btn-sm" onClick={resetBuilder}>Cancel</button>}
          </div>

          {!editing ? (
            <>
              <p className="card-s">Click a step type to add it to a new workflow.</p>
              {STEP_TYPES.map((st) => (
                <div
                  className="step"
                  key={st.value}
                  style={{ cursor: isAdmin ? 'pointer' : 'default' }}
                  onClick={() => {
                    if (!isAdmin) return;
                    setEditing(true);
                    addStep(st.value);
                  }}
                >
                  <span className="step-n">{st.value[0].toUpperCase()}</span>
                  <div>
                    <div className="step-t">{st.label}</div>
                    <div className="step-s">{st.hint}</div>
                  </div>
                </div>
              ))}
            </>
          ) : (
            <form onSubmit={save}>
              <div className="field">
                <label>Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. prod-standard"
                  required
                />
              </div>

              <div style={{ marginBottom: 12 }}>
                <label>Steps</label>
                {steps.map((s, idx) => (
                  <div
                    key={idx}
                    style={{
                      border: '1px solid #e5e7eb',
                      borderRadius: 8,
                      padding: 12,
                      marginBottom: 8,
                      background: '#fff',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span className="step-n">{idx + 1}</span>
                      <strong style={{ fontSize: 13 }}>
                        {STEP_TYPES.find((t) => t.value === s.type)?.label ?? s.type}
                      </strong>
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                        <button className="btn btn-sm" type="button" onClick={() => moveStep(idx, -1)}>↑</button>
                        <button className="btn btn-sm" type="button" onClick={() => moveStep(idx, 1)}>↓</button>
                        <button className="btn btn-sm" type="button" onClick={() => removeStep(idx)}>✕</button>
                      </div>
                    </div>

                    {s.type === 'approval' && (
                      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
                        <div className="field" style={{ margin: 0 }}>
                          <label>Approvers (comma-separated emails)</label>
                          <input
                            value={s.approvers ?? ''}
                            onChange={(e) => updateStep(idx, { approvers: e.target.value })}
                            placeholder="lead@acme.com, sec@acme.com (blank = any admin)"
                          />
                        </div>
                        <div className="field" style={{ margin: 0 }}>
                          <label>Timeout (hours)</label>
                          <input
                            type="number"
                            value={s.timeout_hours ?? 24}
                            onChange={(e) => updateStep(idx, { timeout_hours: parseInt(e.target.value) || 24 })}
                          />
                        </div>
                      </div>
                    )}

                    {s.type === 'notify' && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 2fr', gap: 8 }}>
                        <div className="field" style={{ margin: 0 }}>
                          <label>Channel</label>
                          <select value={s.channel ?? 'email'} onChange={(e) => updateStep(idx, { channel: e.target.value })}>
                            <option value="email">Email</option>
                            <option value="slack">Slack</option>
                            <option value="webhook">Webhook</option>
                          </select>
                        </div>
                        <div className="field" style={{ margin: 0 }}>
                          <label>Destination</label>
                          <input
                            value={
                              s.channel === 'slack' ? (s.webhook_url ?? '') :
                              s.channel === 'webhook' ? (s.url ?? '') :
                              (s.to ?? '')
                            }
                            onChange={(e) => {
                              if (s.channel === 'slack') updateStep(idx, { webhook_url: e.target.value });
                              else if (s.channel === 'webhook') updateStep(idx, { url: e.target.value });
                              else updateStep(idx, { to: e.target.value });
                            }}
                            placeholder={
                              s.channel === 'slack' ? 'https://hooks.slack.com/...' :
                              s.channel === 'webhook' ? 'https://your.app/hook' :
                              'ops@acme.com (blank = requestor)'
                            }
                          />
                        </div>
                        <div className="field" style={{ margin: 0 }}>
                          <label>Message</label>
                          <input
                            value={s.message ?? ''}
                            onChange={(e) => updateStep(idx, { message: e.target.value })}
                            placeholder="Deployment complete"
                          />
                        </div>
                      </div>
                    )}

                    {s.type === 'custom_parameter' && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 2fr', gap: 8 }}>
                        <div className="field" style={{ margin: 0 }}>
                          <label>Provider</label>
                          <select value={s.provider ?? ''} onChange={(e) => updateStep(idx, { provider: e.target.value })}>
                            <option value="">Use account's provider</option>
                            <option value="aws">AWS SSM</option>
                            <option value="gcp">GCP Secret Manager</option>
                            <option value="azure">Azure Key Vault</option>
                          </select>
                        </div>
                        <div className="field" style={{ margin: 0 }}>
                          <label>Name</label>
                          <input
                            value={s.name ?? ''}
                            onChange={(e) => updateStep(idx, { name: e.target.value })}
                            placeholder="/cloudpilot/db-pass"
                          />
                        </div>
                        <div className="field" style={{ margin: 0 }}>
                          <label>Value</label>
                          <input
                            type="password"
                            value={s.value ?? ''}
                            onChange={(e) => updateStep(idx, { value: e.target.value })}
                            placeholder="••••••••"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="field">
                <label>Add step</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {STEP_TYPES.map((st) => (
                    <button
                      className="btn btn-sm"
                      type="button"
                      key={st.value}
                      onClick={() => addStep(st.value)}
                    >
                      + {st.label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" type="submit" disabled={saving}>
                  {saving ? 'Saving…' : 'Save workflow'}
                </button>
              </div>
              {message && <div className="ok-box" style={{ marginTop: 12 }}>{message}</div>}
              {error && <div className="error-text">{error}</div>}
            </form>
          )}
        </div>
      </div>
    </>
  );
}