import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { CloudIcon } from '../components/CloudIcon';
import { CloudSelect } from '../components/CloudSelect';
import { Pagination } from '../components/Pagination';

const DETAIL_KEYS: Record<string, string[]> = {
  aws_vpc: ['cidr_block', 'name', 'tags'],
  aws_subnet: ['cidr_block', 'availability_zone', 'vpc_id'],
  aws_eks_cluster: ['version', 'endpoint', 'vpc_config'],
  aws_db_instance: ['engine', 'instance_class', 'allocated_storage', 'multi_az'],
  aws_instance: ['instance_type', 'ami', 'availability_zone', 'private_ip'],
  aws_s3_bucket: ['bucket', 'region', 'versioning'],
  aws_security_group: ['name', 'description', 'vpc_id'],
  google_compute_network: ['name', 'auto_create_subnetworks'],
  google_compute_subnetwork: ['ip_cidr_range', 'region', 'network'],
  google_container_cluster: ['location', 'initial_node_count', 'min_master_version'],
  google_bigquery_dataset: ['dataset_id', 'location'],
  google_sql_database_instance: ['database_version', 'region', 'tier'],
  azurerm_virtual_network: ['name', 'address_space', 'location'],
  azurerm_subnet: ['name', 'address_prefixes', 'virtual_network_name'],
  azurerm_kubernetes_cluster: ['kubernetes_version', 'location', 'dns_prefix'],
  azurerm_storage_account: ['account_tier', 'account_replication_type', 'location'],
  oci_core_vcn: ['cidr_block', 'display_name'],
  oci_core_subnet: ['cidr_block', 'availability_domain'],
  oci_core_instance: ['shape', 'availability_domain'],
  ibm_is_vpc: ['name', 'resource_group'],
  ibm_is_subnet: ['ipv4_cidr_block', 'zone'],
  alicloud_vpc: ['cidr_block', 'vpc_name'],
  alicloud_vswitch: ['cidr_block', 'zone_id'],
};

function formatValue(v: any): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v.length > 40 ? v.slice(0, 40) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.length ? v.join(', ') : '[]';
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 40 ? s.slice(0, 40) + '…' : s;
  }
  return String(v);
}

function describeResource(r: any): string {
  const meta = r.meta || {};
  const keys = DETAIL_KEYS[r.resource_type];
  if (keys && keys.length) {
    const parts: string[] = [];
    for (const k of keys) {
      if (meta[k] !== undefined && meta[k] !== null && meta[k] !== '') {
        parts.push(`${k}: ${formatValue(meta[k])}`);
      }
    }
    if (parts.length) return parts.join(' · ');
  }
  const fallback = Object.entries(meta)
    .filter(([_, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${formatValue(v)}`);
  return fallback.join(' · ') || '—';
}

const PROVIDER_OPTIONS = [
  { value: 'aws', label: 'AWS', provider: 'aws' },
  { value: 'gcp', label: 'GCP', provider: 'gcp' },
  { value: 'azure', label: 'Azure', provider: 'azure' },
  { value: 'databricks', label: 'Databricks', provider: 'databricks' },
  { value: 'oracle', label: 'Oracle Cloud', provider: 'oracle' },
  { value: 'ibm', label: 'IBM Cloud', provider: 'ibm' },
  { value: 'alibaba', label: 'Alibaba Cloud', provider: 'alibaba' },
];

export function Inventory() {
  const { user } = useAuth();

  const [accounts, setAccounts] = useState<any[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [resources, setResources] = useState<any[]>([]);
  const [teams, setTeams] = useState<{ id: number; name: string }[]>([]);

  const [envFilter, setEnvFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [teamFilter, setTeamFilter] = useState('');
  const [accountSearch, setAccountSearch] = useState('');
  const [resourceSearch, setResourceSearch] = useState('');

  const [acctPage, setAcctPage] = useState(1);
  const [acctTotal, setAcctTotal] = useState(0);
  const [acctPages, setAcctPages] = useState(1);

  const [resPage, setResPage] = useState(1);
  const [resTotal, setResTotal] = useState(0);
  const [resPages, setResPages] = useState(1);

  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingResources, setLoadingResources] = useState(false);
  const [error, setError] = useState('');

  // Load teams once
  useEffect(() => {
    if (!user) return;
    api.listTeams(user.tenant_id, { page: 1, limit: 100 })
      .then((r) => setTeams(r.items.map((t: any) => ({ id: t.id, name: t.name }))))
      .catch(() => setTeams([]));
  }, [user]);

  useEffect(() => {
    if (!user) return;
    setLoadingAccounts(true);
    api
      .listAccounts(user.tenant_id, {
        env: envFilter || undefined,
        provider: providerFilter || undefined,
        team_id: teamFilter ? parseInt(teamFilter) : undefined,
        page: acctPage,
        limit: 10,
      })
      .then((res) => {
        setAccounts(res.items);
        setAcctTotal(res.total);
        setAcctPages(res.pages);
        if ((!selected || !res.items.find((x: any) => x.id === selected)) && res.items.length) {
          setSelected(res.items[0].id);
          setResPage(1);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingAccounts(false));
  }, [user, envFilter, providerFilter, teamFilter, acctPage]);

  useEffect(() => {
    if (selected === null) return;
    setLoadingResources(true);
    api
      .listAccountResources(selected, { page: resPage, limit: 10 })
      .then((res) => {
        setResources(res.items);
        setResTotal(res.total);
        setResPages(res.pages);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingResources(false));
  }, [selected, resPage]);

  const handleSelectAccount = (id: number) => {
    setSelected(id);
    setResPage(1);
  };

  const handleProviderChange = (value: string) => {
    setProviderFilter(value);
    setAcctPage(1);
  };

  const handleEnvChange = (value: string) => {
    setEnvFilter(value);
    setAcctPage(1);
  };

  const handleTeamChange = (value: string) => {
    setTeamFilter(value);
    setAcctPage(1);
  };

  const clearFilters = () => {
    setEnvFilter('');
    setProviderFilter('');
    setTeamFilter('');
    setAcctPage(1);
  };

  const hasFilters = Boolean(envFilter || providerFilter || teamFilter);

  const current = accounts.find((a) => a.id === selected);

  const filteredAccounts = useMemo(() => {
    const q = accountSearch.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter(
      (a) =>
        (a.account_ref || '').toLowerCase().includes(q) ||
        (a.provider || '').toLowerCase().includes(q) ||
        (a.env || '').toLowerCase().includes(q)
    );
  }, [accounts, accountSearch]);

  const filteredResources = useMemo(() => {
    const q = resourceSearch.trim().toLowerCase();
    if (!q) return resources;
    return resources.filter(
      (r) =>
        (r.resource_id || '').toLowerCase().includes(q) ||
        (r.resource_type || '').toLowerCase().includes(q) ||
        (r.state || '').toLowerCase().includes(q) ||
        JSON.stringify(r.meta || {}).toLowerCase().includes(q)
    );
  }, [resources, resourceSearch]);

  if (!user) return null;

  return (
    <>
      <div className="row">
        <div>
          <h1 className="h1">Inventory</h1>
          <p className="sub">Pick an account on the left, then browse its resources.</p>
        </div>
      </div>

      <div className="filters">
        <div className="filter-group">
          <label>Provider</label>
          <CloudSelect
            value={providerFilter}
            onChange={handleProviderChange}
            options={PROVIDER_OPTIONS}
            placeholder="All providers"
          />
        </div>
        <div className="filter-group">
          <label>Environment</label>
          <select value={envFilter} onChange={(e) => handleEnvChange(e.target.value)}>
            <option value="">All envs</option>
            <option value="DEV">DEV</option>
            <option value="UAT">UAT</option>
            <option value="PROD">PROD</option>
          </select>
        </div>
        <div className="filter-group">
          <label>Team</label>
          <select value={teamFilter} onChange={(e) => handleTeamChange(e.target.value)}>
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
        {hasFilters && (
          <button className="btn btn-sm" type="button" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      <div className="inv">
        <aside className="inv-left">
          <input
            placeholder="Search accounts…"
            value={accountSearch}
            onChange={(e) => setAccountSearch(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <div className="cloud-group">
            Accounts ({filteredAccounts.length}
            {accountSearch ? ` of ${accounts.length}` : ''})
          </div>

          {loadingAccounts ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8 }}>
              {[1, 2, 3].map((i) => (
                <div key={i} className="skeleton" style={{ height: 36 }} />
              ))}
            </div>
          ) : filteredAccounts.length === 0 ? (
            <p className="muted" style={{ padding: 12, fontSize: 13 }}>
              {accountSearch
                ? 'No accounts match your search.'
                : hasFilters
                  ? 'No accounts match the current filters.'
                  : 'No accounts configured yet.'}
            </p>
          ) : (
            filteredAccounts.map((a) => (
              <div
                key={a.id}
                className={`acct ${selected === a.id ? 'active' : ''}`}
                onClick={() => handleSelectAccount(a.id)}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CloudIcon provider={a.provider} size={16} />
                  <span
                    className={`tag tag-${a.env === 'PROD' ? 'red' : a.env === 'UAT' ? 'blue' : 'amber'}`}
                  >
                    {a.env}
                  </span>
                  {a.account_ref}
                </span>
                <span className="acct-count">{a.resource_count}</span>
              </div>
            ))
          )}

          <Pagination
            page={acctPage}
            pages={acctPages}
            total={acctTotal}
            limit={10}
            onChange={setAcctPage}
          />
        </aside>

        <div className="inv-right">
          {current ? (
            <>
              <div
                style={{
                  padding: '16px 18px',
                  borderBottom: '1px solid #e5e7eb',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <CloudIcon provider={current.provider} size={20} />
                    {current.account_ref}{' '}
                    <span
                      className={`tag tag-${current.env === 'PROD' ? 'red' : current.env === 'UAT' ? 'blue' : 'amber'}`}
                    >
                      {current.env}
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                    {current.provider} · {filteredResources.length} of {resources.length} resources
                  </div>
                </div>
                <input
                  placeholder="Search in account…"
                  value={resourceSearch}
                  onChange={(e) => setResourceSearch(e.target.value)}
                  style={{ width: 220 }}
                />
              </div>

              {loadingResources ? (
                <p className="muted" style={{ padding: 20, fontSize: 13 }}>
                  Loading…
                </p>
              ) : resources.length === 0 ? (
                <p className="muted" style={{ padding: 20, fontSize: 13 }}>
                  No resources yet — run a provisioning request against this account.
                </p>
              ) : filteredResources.length === 0 ? (
                <p className="muted" style={{ padding: 20, fontSize: 13 }}>
                  No resources match "{resourceSearch}".
                </p>
              ) : (
                <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Details</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredResources.map((r) => (
                      <tr key={r.id}>
                        <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                          {r.resource_id}
                        </td>
                        <td className="muted" style={{ fontSize: 12 }}>
                          {r.resource_type}
                        </td>
                        <td style={{ fontSize: 12 }}>{describeResource(r)}</td>
                        <td>
                          <span className={`tag tag-${r.state === 'Active' ? 'green' : 'amber'}`}>
                            {r.state}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}

              <div style={{ padding: '0 18px' }}>
                <Pagination
                  page={resPage}
                  pages={resPages}
                  total={resTotal}
                  limit={10}
                  onChange={setResPage}
                />
              </div>
            </>
          ) : (
            <p className="muted" style={{ padding: 20 }}>
              Pick an account to see its resources.
            </p>
          )}
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}
    </>
  );
}