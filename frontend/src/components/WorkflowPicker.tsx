import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';

export interface Workflow {
  id: number;
  name: string;
  steps_json: {
    type: string;
    approvers?: string[];
    timeout_hours?: number;
    channel?: string;
    message?: string;
  }[];
}

function stepLabel(s: { type: string; approvers?: string[] }): string {
  switch (s.type) {
    case 'tf_plan': return 'Plan';
    case 'tf_apply': return 'Apply';
    case 'approval':
      return s.approvers && s.approvers.length
        ? `Approval (${s.approvers.length} approver${s.approvers.length === 1 ? '' : 's'})`
        : 'Approval';
    case 'notify': return 'Notify';
    case 'custom_parameter': return 'Write secret';
    default: return s.type;
  }
}

interface Props {
  value: number | null;
  onChange: (id: number | null) => void;
}

export function WorkflowPicker({ value, onChange }: Props) {
  const { user } = useAuth();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    api.listWorkflows(user.tenant_id)
      .then((list) => {
        const ws = list as Workflow[];
        setWorkflows(ws);
        // Auto-select the first workflow on first load so the user doesn't
        // have to open the dropdown if only one exists.
        if (value === null && ws.length > 0) {
          onChange(ws[0].id);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const selected = workflows.find((w) => w.id === value);

  return (
    <div>
      <label className="field-label">Approval workflow</label>

      {loading ? (
        <p className="muted" style={{ fontSize: 12 }}>Loading workflows…</p>
      ) : error ? (
        <p className="error-text" style={{ fontSize: 12 }}>{error}</p>
      ) : workflows.length === 0 ? (
        <div className="warn-box" style={{ fontSize: 12 }}>
          No workflows defined. The default flow (plan → approval → apply) will be used.
          Admins can create workflows on the <b>Workflows</b> page.
        </div>
      ) : (
        <>
          <select
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
            style={{ width: '100%' }}
          >
            <option value="">Default (plan → approval → apply)</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} — {(w.steps_json || []).map(stepLabel).join(' → ')}
              </option>
            ))}
          </select>

          {selected && (
            <div
              style={{
                marginTop: 8,
                padding: 10,
                background: '#f8fafc',
                borderRadius: 6,
                border: '1px solid #e5e7eb',
              }}
            >
              <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                Steps this request will follow:
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                {(selected.steps_json || []).map((s, i) => (
                  <span
                    key={i}
                    className={`tag tag-${
                      s.type === 'approval' ? 'amber'
                      : s.type === 'tf_apply' ? 'green'
                      : s.type === 'tf_plan' ? 'blue'
                      : s.type === 'notify' ? 'gray'
                      : 'blue'
                    }`}
                    style={{ fontSize: 11 }}
                  >
                    {i + 1}. {stepLabel(s)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}