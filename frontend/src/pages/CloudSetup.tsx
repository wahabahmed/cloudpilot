import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { CloudIcon } from '../components/CloudIcon';
import { Pagination } from '../components/Pagination';

const PROVIDERS = ['aws', 'gcp', 'azure', 'databricks', 'oracle', 'ibm', 'alibaba'] as const;
const ENVS = ['DEV', 'UAT', 'PROD'] as const;

// Which providers can CloudPilot actually create accounts in?
//   aws     → Organizations CreateAccount
//   gcp     → Cloud Resource Manager Projects Create
//   azure   → Subscription Alias (needs billing_scope)
//   alibaba → BSS OpenAPI CreateAgAccount
//   oracle  → NOT supported (subaccounts.py raises)
//   ibm     → NOT supported (subaccounts.py raises)
const CAN_CREATE: Record<string, boolean> = {
  aws: true,
  gcp: true,
  azure: true,
  oracle: false,
  ibm: false,
  alibaba: true,
  databricks: false,
};

const FIELDS: Record<string, { key: string; label: string; placeholder: string; hint?: string }[]> = {
  aws: [
    { key: 'bootstrap_access_key_id',
      label: 'Bootstrap access key ID (optional)',
      placeholder: 'AKIA...',
      hint: 'IAM user that will assume the root role. Leave blank to use PLATFORM_AWS_* from .env.' },
    { key: 'bootstrap_secret_access_key',
      label: 'Bootstrap secret access key (optional)',
      placeholder: '••••••••',
      hint: 'Encrypted at rest. Never returned to the browser.' },
    { key: 'role_arn', label: 'Root role ARN',
      placeholder: 'arn:aws:iam::MGMT:role/CloudPilotRoot' },
    { key: 'external_id', label: 'External ID',
      placeholder: 'ext-abc-123' },
    { key: 'region', label: 'Region',
      placeholder: 'us-east-1' },
    { key: 'management_account_id', label: 'Management account ID',
      placeholder: '999999999999',
      hint: '12-digit AWS account number of the root/management account' },
    { key: 'member_role_name', label: 'Member role name (optional)',
      placeholder: 'OrganizationAccountAccessRole' },
  ],
  gcp: [
    { key: 'project_id', label: 'Root project ID', placeholder: 'cloudpilot-root' },
    { key: 'wif_config_json', label: 'Workload Identity config (JSON)',
      placeholder: '{"type":"external_account",...}' },
    { key: 'member_sa_template', label: 'Member SA template (optional)',
      placeholder: 'cloudpilot@{project}.iam.gserviceaccount.com' },
  ],
  azure: [
    { key: 'tenant_id', label: 'Tenant ID', placeholder: 'tenant-uuid' },
    { key: 'client_id', label: 'Client ID', placeholder: 'client-uuid' },
    { key: 'client_secret', label: 'Client Secret', placeholder: '••••••••' },
    { key: 'subscription_id', label: 'Default subscription ID (optional)', placeholder: 'sub-uuid' },
  ],
  databricks: [
    { key: 'host', label: 'Workspace URL', placeholder: 'https://my.cloud.databricks.com' },
    { key: 'token', label: 'Access Token', placeholder: '••••••••' },
  ],
  oracle: [
    { key: 'user_ocid', label: 'User OCID', placeholder: 'ocid1.user...' },
    { key: 'fingerprint', label: 'API Key Fingerprint', placeholder: 'aa:bb:cc:...' },
    { key: 'tenancy_ocid', label: 'Root tenancy OCID', placeholder: 'ocid1.tenancy...' },
    { key: 'region', label: 'Region', placeholder: 'us-ashburn-1' },
    { key: 'private_key_path', label: 'Private Key Path', placeholder: '/tmp/oci_key.pem' },
  ],
  ibm: [
    { key: 'api_key', label: 'API Key', placeholder: '••••••••' },
    { key: 'account_id', label: 'Root account ID', placeholder: 'ibm-account-id' },
  ],
  alibaba: [
    { key: 'access_key_id', label: 'Access Key ID', placeholder: 'LTAI...' },
    { key: 'access_key_secret', label: 'Access Key Secret', placeholder: '••••••••' },
    { key: 'region', label: 'Region', placeholder: 'cn-hangzhou' },
    { key: 'member_role_name', label: 'Member role name (optional)', placeholder: 'CloudPilotRole' },
  ],
};

function isSecretField(key: string): boolean {
  return (
    key.includes('secret') ||
    key === 'token' ||
    key === 'api_key' ||
    key === 'password'
  );
}

export function CloudSetup() {
  const { user } = useAuth();
  const [provider, setProvider] = useState<string>('aws');
  const [env, setEnv] = useState<string>('DEV');
  const [creds, setCreds] = useState<Record<string, any>>({});
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // ---------- accounts ----------
  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountPage, setAccountPage] = useState(1);
  const [accountTotal, setAccountTotal] = useState(0);
  const [accountPages, setAccountPages] = useState(1);
  const [accountMsg, setAccountMsg] = useState('');
  const [accountErr, setAccountErr] = useState('');
  const [accountBusy, setAccountBusy] = useState<Record<number, boolean>>({});

  // ---------- CREATE NEW form ----------
  const [createForm, setCreateForm] = useState({
    name: '',
    email: '',
    parent: '',
    billing_scope: '',
  });
  const [creating, setCreating] = useState(false);

  // ---------- REGISTER EXISTING form ----------
  const [newAccount, setNewAccount] = useState({ account_ref: '', cloud_account_id: '' });

  // ---------- teams ----------
  const [teams, setTeams] = useState<{ id: number; name: string }[]>([]);
  const [accountTeams, setAccountTeams] = useState<Record<number, { id: number; name: string }[]>>({});
  const [teamBusy, setTeamBusy] = useState<Record<number, boolean>>({});
  const [teamMsg, setTeamMsg] = useState<Record<number, { kind: 'ok' | 'err'; text: string } | undefined>>({});

  // Load credentials
  useEffect(() => {
    if (!user) return;
    setMessage(''); setError(''); setForm({});
    api.listCredentials(user.tenant_id)
      .then((list) => {
        const map: Record<string, any> = {};
        (list as any[]).forEach((c) => { map[`${c.provider}:${c.env}`] = c; });
        setCreds(map);
      })
      .catch((e) => setError(e.message));
  }, [user]);

  // Load teams for the tenant
  useEffect(() => {
    if (!user) return;
    api.listTeams(user.tenant_id, { page: 1, limit: 100 })
      .then((r) => setTeams(r.items.map((t: any) => ({ id: t.id, name: t.name }))))
      .catch(() => setTeams([]));
  }, [user]);

  // Load account→team mappings
  const refreshAccountTeams = () => {
    if (!user) return;
    api.listAccountTeams(user.tenant_id)
      .then((m) => {
        const norm: Record<number, { id: number; name: string }[]> = {};
        Object.entries(m).forEach(([k, v]) => { norm[Number(k)] = v; });
        setAccountTeams(norm);
      })
      .catch(() => setAccountTeams({}));
  };

  useEffect(() => { refreshAccountTeams(); }, [user]);

  const refreshAccounts = () => {
    if (!user) return;
    setAccountsLoading(true);
    api.listAccounts(user.tenant_id, {
      provider,
      env,
      page: accountPage,
      limit: 10,
    })
      .then((r) => {
        setAccounts(r.items);
        setAccountTotal(r.total);
        setAccountPages(r.pages);
      })
      .catch((e) => setAccountErr(e.message))
      .finally(() => setAccountsLoading(false));
  };

  useEffect(() => { refreshAccounts(); }, [user, provider, env, accountPage]);

  if (!user) return null;
  if (user.role !== 'admin') {
    return (
      <div className="card">
        <h2 className="card-h">Admin only</h2>
        <p className="muted" style={{ fontSize: 13 }}>You must be an admin to view Cloud Setup.</p>
      </div>
    );
  }

  const current = creds[`${provider}:${env}`];
  const fields = FIELDS[provider];
  const canCreate = CAN_CREATE[provider] === true;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setError(''); setMessage('');
    try {
      const payload: Record<string, any> = {};
      for (const f of fields) {
        if (f.key === 'wif_config_json') {
          payload.wif_config = JSON.parse(form[f.key] || '{}');
        } else {
          payload[f.key] = form[f.key] ?? '';
        }
      }
      const res = await api.storeCredential(user.tenant_id, provider, env, payload);
      setMessage(res.created
        ? `Root credential for ${provider.toUpperCase()} · ${env} created.`
        : `Root credential for ${provider.toUpperCase()} · ${env} replaced.`);
      const list = await api.listCredentials(user.tenant_id);
      const map: Record<string, any> = {};
      (list as any[]).forEach((c) => { map[`${c.provider}:${c.env}`] = c; });
      setCreds(map);
      setForm({});
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const verify = async () => {
    if (!current) return;
    setVerifying(true); setError(''); setMessage('');
    try {
      const res = await api.verifyCredential(user.tenant_id, current.id);
      if (res.valid) setMessage(`✓ Root credential for ${provider.toUpperCase()} · ${env} is reachable.`);
      else setError(`✗ Verification failed: ${res.error}`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setVerifying(false);
    }
  };

  // ---------- CREATE NEW sub-account ----------
  const createSubaccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setAccountMsg(''); setAccountErr('');

    if (!canCreate) {
      setAccountErr(
        `${provider.toUpperCase()} does not support programmatic account creation. ` +
        `Create the account in the ${provider.toUpperCase()} console, then use "Register existing".`
      );
      return;
    }
    if (!createForm.name.trim()) {
      setAccountErr('Account name is required.');
      return;
    }
    if (provider === 'aws' && !createForm.email.trim()) {
      setAccountErr('Email is required for AWS (AWS Organizations needs a unique email per account).');
      return;
    }
    if (provider === 'gcp' && !createForm.parent.trim()) {
      setAccountErr("Parent is required for GCP (e.g. 'folders/123' or 'organizations/456').");
      return;
    }
    if (provider === 'azure' && !createForm.billing_scope.trim()) {
      setAccountErr('Billing scope is required for Azure subscription creation.');
      return;
    }

    setCreating(true);
    try {
      // Step 1: create an account row without cloud_account_id.
      // We derive a unique friendly name so two concurrent "create" clicks
      // don't collide on the (tenant, env, account_ref) uniqueness check.
      const suffix = Math.random().toString(36).slice(2, 6);
      const ref = `${createForm.name.trim()}-${suffix}`;

      const row = await api.addAccount(user.tenant_id, {
        provider,
        account_ref: ref,
        env,
        // cloud_account_id omitted on purpose
      });

      // Step 2: call the backend to actually create it in the cloud.
      const res = await api.createSubaccount(user.tenant_id, row.id, {
        name: createForm.name.trim(),
        email: provider === 'aws' ? createForm.email.trim() : undefined,
        parent: provider === 'gcp' ? createForm.parent.trim() : undefined,
        billing_scope: provider === 'azure' ? createForm.billing_scope.trim() : undefined,
      });

      setAccountMsg(
        `Created "${createForm.name.trim()}" as ${provider.toUpperCase()} ` +
        `account ${res.cloud_account_id}. ` +
        (provider === 'aws'
          ? 'AWS needs ~1 minute before "Verify" will succeed.'
          : 'You can click "Verify" now.')
      );
      setCreateForm({ name: '', email: '', parent: '', billing_scope: '' });
      setAccountPage(1);
      refreshAccounts();
    } catch (e: any) {
      setAccountErr(e.message);
      // Refresh in case the row was created but the cloud call failed —
      // the row is now visible with a NULL cloud_account_id so the user
      // can see what state the request is in.
      refreshAccounts();
    } finally {
      setCreating(false);
    }
  };

  // ---------- REGISTER existing ----------
  const registerAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setAccountMsg(''); setAccountErr('');
    try {
      if (!newAccount.account_ref.trim()) throw new Error('friendly name is required');
      if (!newAccount.cloud_account_id.trim()) throw new Error('native id is required');
      const res = await api.addAccount(user.tenant_id, {
        provider,
        account_ref: newAccount.account_ref.trim(),
        env,
        cloud_account_id: newAccount.cloud_account_id.trim(),
      });
      setAccountMsg(`Registered "${res.account_ref}" (${res.cloud_account_id}).`);
      setNewAccount({ account_ref: '', cloud_account_id: '' });
      setAccountPage(1);
      refreshAccounts();
    } catch (e: any) {
      setAccountErr(e.message);
    }
  };

  const verifyAccount = async (aid: number) => {
    setAccountBusy((b) => ({ ...b, [aid]: true }));
    setAccountMsg(''); setAccountErr('');
    try {
      const res = await api.verifyAccount(aid);
      if (res.valid) setAccountMsg('✓ Account is reachable from CloudPilot.');
      else setAccountErr(`✗ ${res.error}`);
    } catch (e: any) {
      setAccountErr(e.message);
    } finally {
      setAccountBusy((b) => ({ ...b, [aid]: false }));
    }
  };

  // ---------- team attach / detach ----------
  const attachToTeam = async (accountId: number, teamId: number) => {
    if (!teamId) return;
    const account = accounts.find((a) => a.id === accountId);
    const team = teams.find((t) => t.id === teamId);
    if (account && account.env === 'PROD') {
      const ok = window.confirm(
        `Attach PROD account "${account.account_ref}" to team "${team?.name ?? teamId}"?\n\n` +
        `Every member of that team will immediately be able to submit requests against it.`
      );
      if (!ok) return;
    }

    setTeamBusy((b) => ({ ...b, [accountId]: true }));
    setTeamMsg((m) => ({ ...m, [accountId]: undefined }));
    try {
      const res = await api.attachAccount(teamId, accountId);
      setTeamMsg((m) => ({
        ...m,
        [accountId]: { kind: 'ok', text: res.status === 'already attached' ? 'Already attached.' : 'Attached.' },
      }));
      refreshAccountTeams();
    } catch (e: any) {
      setTeamMsg((m) => ({ ...m, [accountId]: { kind: 'err', text: e.message } }));
    } finally {
      setTeamBusy((b) => ({ ...b, [accountId]: false }));
    }
  };

  const detachFromTeam = async (accountId: number, teamId: number) => {
    const account = accounts.find((a) => a.id === accountId);
    const team = teams.find((t) => t.id === teamId);
    const ok = window.confirm(
      `Detach "${account?.account_ref ?? accountId}" from team "${team?.name ?? teamId}"?`
    );
    if (!ok) return;

    setTeamBusy((b) => ({ ...b, [accountId]: true }));
    setTeamMsg((m) => ({ ...m, [accountId]: undefined }));
    try {
      await api.detachAccount(teamId, accountId);
      setTeamMsg((m) => ({ ...m, [accountId]: { kind: 'ok', text: 'Detached.' } }));
      refreshAccountTeams();
    } catch (e: any) {
      setTeamMsg((m) => ({ ...m, [accountId]: { kind: 'err', text: e.message } }));
    } finally {
      setTeamBusy((b) => ({ ...b, [accountId]: false }));
    }
  };

  return (
    <>
      <div className="row">
        <div>
          <h1 className="h1">Cloud Setup</h1>
          <p className="sub">Configure the root credential, register sub-accounts, and assign them to teams.</p>
        </div>
      </div>

      <div className="card" style={{ borderLeft: '3px solid #f59e0b' }}>
        <span className="role role-admin">Admin only</span>
        <span className="muted" style={{ fontSize: 13, marginLeft: 8 }}>
          Exactly one root credential per (provider, environment). Sub-accounts inherit it.
        </span>
      </div>

      <div className="tabs">
        {PROVIDERS.map((p) => (
          <button key={p} className={`tab ${provider === p ? 'active' : ''}`}
                  onClick={() => { setProvider(p); setEnv('DEV'); setAccountPage(1); setForm({}); setMessage(''); setError(''); setAccountMsg(''); setAccountErr(''); }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <CloudIcon provider={p} size={16} />
            {p.toUpperCase()}
          </button>
        ))}
      </div>

      {/* ============================================================ */}
      {/* 1. ROOT CREDENTIAL                                            */}
      {/* ============================================================ */}
      <div className="card">
        <div className="env-tabs">
          {ENVS.map((e) => (
            <button
              key={e}
              className={`env-tab ${env === e ? 'active' : ''}`}
              onClick={() => { setEnv(e); setAccountPage(1); setForm({}); setMessage(''); setError(''); setAccountMsg(''); setAccountErr(''); }}
            >
              {e}
            </button>
          ))}
        </div>

        <h2 className="card-h">Root credential — {provider.toUpperCase()} · {env}</h2>
        <p className="card-s">
          This is the identity CloudPilot uses to create and manage sub-accounts.
          Saving it again <strong>replaces</strong> the existing credential — every
          sub-account that inherits it will use the new value on the next job.
        </p>

        {current ? (
          <div className="ok-box" style={{ marginBottom: 12 }}>
            <strong>Root credential configured</strong> — id {current.id}
            {current.verified_at && ` · verified at ${new Date(current.verified_at).toLocaleString()}`}
          </div>
        ) : (
          <div className="warn-box" style={{ marginBottom: 12 }}>
            No root credential yet for {provider.toUpperCase()} · {env}. Fill in the form below.
          </div>
        )}

        <form onSubmit={save}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {fields.map((f) => (
              <div className="field" key={f.key}>
                <label>{f.label}</label>
                <input
                  type={isSecretField(f.key) ? 'password' : 'text'}
                  value={form[f.key] ?? ''}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  placeholder={f.placeholder}
                  autoComplete="off"
                />
                {f.hint && <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{f.hint}</div>}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving
                ? 'Saving…'
                : current
                  ? 'Replace root credential'
                  : 'Save root credential'}
            </button>
            {current && (
              <button className="btn" type="button" onClick={verify} disabled={verifying}>
                {verifying ? 'Verifying…' : 'Verify credential'}
              </button>
            )}
          </div>
          {message && <div className="ok-box" style={{ marginTop: 12 }}>{message}</div>}
          {error && <div className="error-text">{error}</div>}
        </form>
      </div>

      {/* ============================================================ */}
      {/* 2. SUB-ACCOUNTS                                               */}
      {/* ============================================================ */}
      <div className="card">
        <h2 className="card-h">Sub-accounts — {provider.toUpperCase()} · {env}</h2>
        <p className="card-s">
          Choose one of the two ways to bring accounts into CloudPilot, then
          assign them to teams below.
        </p>

        {/* ---------- TWO SIDE-BY-SIDE FORMS ---------- */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(280px, 1fr) minmax(280px, 1fr)',
          gap: 14,
          marginBottom: 16,
        }}>

          {/* CREATE NEW */}
          <div style={{
            border: '1px solid #dbeafe',
            background: '#eff6ff',
            borderRadius: 10,
            padding: 14,
          }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>
              Create a new {provider.toUpperCase()} sub-account
            </h3>
            <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
              {canCreate
                ? `CloudPilot will provision a new ${provider.toUpperCase()} account under your organization using the root credential above.`
                : `${provider.toUpperCase()} does not support programmatic account creation. Use "Register existing" instead.`}
            </p>

            {canCreate ? (
              <form onSubmit={createSubaccount} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input
                  placeholder="Account name (e.g. wf-aws-prod)"
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  required
                />
                {provider === 'aws' && (
                  <input
                    type="email"
                    placeholder="Owner email (unique per AWS account)"
                    value={createForm.email}
                    onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                    required
                  />
                )}
                {provider === 'gcp' && (
                  <input
                    placeholder="Parent (folders/123 or organizations/456)"
                    value={createForm.parent}
                    onChange={(e) => setCreateForm({ ...createForm, parent: e.target.value })}
                    required
                  />
                )}
                {provider === 'azure' && (
                  <input
                    placeholder="Billing scope (…/enrollmentAccounts/12345)"
                    value={createForm.billing_scope}
                    onChange={(e) => setCreateForm({ ...createForm, billing_scope: e.target.value })}
                    required
                  />
                )}
                <button className="btn btn-primary" type="submit" disabled={creating}>
                  {creating
                    ? 'Creating…'
                    : `Create ${provider.toUpperCase()} account`}
                </button>
              </form>
            ) : (
              <div className="muted" style={{ fontSize: 12, padding: 8, background: '#f8fafc', borderRadius: 6 }}>
                Programmatic creation not supported. Create the account in the
                {' '}{provider.toUpperCase()} console, then use the form on the right.
              </div>
            )}
          </div>

          {/* REGISTER EXISTING */}
          <div style={{
            border: '1px solid #e5e7eb',
            background: '#fafbfc',
            borderRadius: 10,
            padding: 14,
          }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>
              Register an existing {provider.toUpperCase()} account
            </h3>
            <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
              Already have an account? Paste its native ID and CloudPilot will
              manage it from here. No cloud API call is made.
            </p>
            <form onSubmit={registerAccount} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                placeholder="Friendly name (e.g. wf-aws-dev)"
                value={newAccount.account_ref}
                onChange={(e) => setNewAccount({ ...newAccount, account_ref: e.target.value })}
                required
              />
              <input
                placeholder="Native ID (AWS account no. / GCP project / Azure subscription / tenancy OCID)"
                value={newAccount.cloud_account_id}
                onChange={(e) => setNewAccount({ ...newAccount, cloud_account_id: e.target.value })}
                required
              />
              <button className="btn" type="submit">+ Register existing</button>
            </form>
          </div>
        </div>

        {(accountMsg || accountErr) && (
          <div style={{ marginBottom: 12 }}>
            {accountMsg && <div className="ok-box">{accountMsg}</div>}
            {accountErr && <div className="error-text">{accountErr}</div>}
          </div>
        )}

        {/* ---------- TABLE ---------- */}
        {accountsLoading ? (
          <p className="muted" style={{ fontSize: 13 }}>Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            No {provider.toUpperCase()} · {env} sub-accounts yet. Use one of the
            forms above.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Friendly name</th>
                  <th>Native ID</th>
                  <th>Env</th>
                  <th style={{ minWidth: 260 }}>Teams</th>
                  <th>Resources</th>
                  <th style={{ width: 200 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const busy = Boolean(accountBusy[a.id]);
                  const tbusy = Boolean(teamBusy[a.id]);
                  const tmsg = teamMsg[a.id];
                  const attached = accountTeams[a.id] ?? [];

                  return (
                    <tr key={a.id}>
                      <td>{a.account_ref}</td>
                      <td>
                        {a.cloud_account_id
                          ? <code>{a.cloud_account_id}</code>
                          : <span className="muted">not created yet</span>}
                      </td>
                      <td>
                        <span className={`tag tag-${a.env === 'PROD' ? 'red' : a.env === 'UAT' ? 'blue' : 'amber'}`}>
                          {a.env}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                          {attached.map((team) => (
                            <span
                              key={team.id}
                              className="tag tag-green"
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                            >
                              {team.name}
                              <button
                                type="button"
                                onClick={() => detachFromTeam(a.id, team.id)}
                                disabled={tbusy}
                                style={{
                                  background: 'transparent',
                                  border: 0,
                                  color: 'inherit',
                                  cursor: tbusy ? 'default' : 'pointer',
                                  padding: 0,
                                  lineHeight: 1,
                                  fontSize: 13,
                                }}
                                title="Detach from this team"
                              >
                                ×
                              </button>
                            </span>
                          ))}

                          {attached.length === 0 && (
                            <span className="muted" style={{ fontSize: 11 }}>unassigned</span>
                          )}

                          <select
                            value=""
                            onChange={(e) => attachToTeam(a.id, Number(e.target.value))}
                            disabled={tbusy || teams.length === 0}
                            style={{ marginLeft: 6, fontSize: 12 }}
                          >
                            <option value="">+ attach to team…</option>
                            {teams
                              .filter((t) => !attached.some((x) => x.id === t.id))
                              .map((t) => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                          </select>
                        </div>
                        {tmsg && (
                          <div
                            className={tmsg.kind === 'ok' ? 'ok-box' : 'error-text'}
                            style={{ marginTop: 4, fontSize: 11 }}
                          >
                            {tmsg.text}
                          </div>
                        )}
                      </td>
                      <td>{a.resource_count ?? 0}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {a.cloud_account_id ? (
                          <>
                            <button
                              className="btn btn-sm"
                              onClick={() => verifyAccount(a.id)}
                              disabled={busy}
                            >
                              {busy ? '…' : 'Verify'}
                            </button>
                            <Link
                              to={`/import?account=${a.id}`}
                              className="btn btn-sm"
                              style={{ marginLeft: 6 }}
                            >
                              Import →
                            </Link>
                          </>
                        ) : (
                          <span className="muted" style={{ fontSize: 11 }}>
                            waiting for native ID
                          </span>
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
          page={accountPage}
          pages={accountPages}
          total={accountTotal}
          limit={10}
          onChange={setAccountPage}
        />
      </div>
    </>
  );
}