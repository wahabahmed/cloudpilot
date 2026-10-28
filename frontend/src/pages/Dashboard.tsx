import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { CloudSelect } from '../components/CloudSelect';
import { WorkflowPicker } from '../components/WorkflowPicker';

const SERVICES: Record<string, Record<string, { slug: string; label: string }[]>> = {
  aws: {
    Compute: [
      { slug: 'ec2', label: 'EC2' },
      { slug: 'ecs', label: 'ECS' },
      { slug: 'eks', label: 'EKS' },
      { slug: 'lambda', label: 'Lambda' },
      { slug: 'fargate', label: 'Fargate' },
      { slug: 'batch', label: 'Batch' },
      { slug: 'lightsail', label: 'Lightsail' },
    ],
    Networking: [
      { slug: 'vpc', label: 'VPC' },
      { slug: 'route53', label: 'Route 53 (DNS)' },
      { slug: 'alb', label: 'ALB' },
      { slug: 'nlb', label: 'NLB' },
      { slug: 'cloudfront', label: 'CloudFront' },
      { slug: 'api_gateway', label: 'API Gateway' },
      { slug: 'waf', label: 'WAF' },
      { slug: 'vpn_gateway', label: 'VPN Gateway' },
      { slug: 'direct_connect', label: 'Direct Connect' },
      { slug: 'transit_gateway', label: 'Transit Gateway' },
    ],
    Database: [
      { slug: 'rds', label: 'RDS' },
      { slug: 'aurora', label: 'Aurora' },
      { slug: 'dynamodb', label: 'DynamoDB' },
      { slug: 'elasticache', label: 'ElastiCache' },
      { slug: 'redshift', label: 'Redshift' },
      { slug: 'documentdb', label: 'DocumentDB' },
      { slug: 'neptune', label: 'Neptune' },
    ],
    Storage: [
      { slug: 's3', label: 'S3' },
      { slug: 'efs', label: 'EFS' },
      { slug: 'fsx', label: 'FSx' },
      { slug: 'glacier', label: 'Glacier' },
      { slug: 'ebs', label: 'EBS' },
    ],
    Integration: [
      { slug: 'sqs', label: 'SQS' },
      { slug: 'sns', label: 'SNS' },
      { slug: 'kinesis', label: 'Kinesis' },
      { slug: 'step_functions', label: 'Step Functions' },
      { slug: 'eventbridge', label: 'EventBridge' },
      { slug: 'mq', label: 'Amazon MQ' },
    ],
    'AI/ML': [
      { slug: 'sagemaker', label: 'SageMaker' },
      { slug: 'bedrock', label: 'Bedrock' },
      { slug: 'comprehend', label: 'Comprehend' },
      { slug: 'rekognition', label: 'Rekognition' },
      { slug: 'transcribe', label: 'Transcribe' },
    ],
    Security: [
      { slug: 'iam', label: 'IAM' },
      { slug: 'cognito', label: 'Cognito' },
      { slug: 'kms', label: 'KMS' },
      { slug: 'secrets_manager', label: 'Secrets Manager' },
      { slug: 'acm', label: 'ACM' },
      { slug: 'guardduty', label: 'GuardDuty' },
    ],
    Analytics: [
      { slug: 'athena', label: 'Athena' },
      { slug: 'emr', label: 'EMR' },
      { slug: 'glue', label: 'Glue' },
      { slug: 'quicksight', label: 'QuickSight' },
      { slug: 'opensearch', label: 'OpenSearch' },
    ],
    Management: [
      { slug: 'cloudwatch', label: 'CloudWatch' },
      { slug: 'cloudtrail', label: 'CloudTrail' },
      { slug: 'systems_manager', label: 'Systems Manager' },
      { slug: 'config', label: 'Config' },
      { slug: 'organizations', label: 'Organizations' },
    ],
  },
  gcp: {
    Compute: [
      { slug: 'compute_engine', label: 'Compute Engine' },
      { slug: 'gke', label: 'GKE' },
      { slug: 'cloud_run', label: 'Cloud Run' },
      { slug: 'cloud_functions', label: 'Cloud Functions' },
      { slug: 'app_engine', label: 'App Engine' },
    ],
    Networking: [
      { slug: 'cloud_load_balancing', label: 'Cloud Load Balancing' },
      { slug: 'cloud_dns', label: 'Cloud DNS' },
      { slug: 'cloud_cdn', label: 'Cloud CDN' },
      { slug: 'vpc', label: 'VPC' },
      { slug: 'cloud_nat', label: 'Cloud NAT' },
      { slug: 'cloud_vpn', label: 'Cloud VPN' },
      { slug: 'interconnect', label: 'Interconnect' },
    ],
    Database: [
      { slug: 'cloud_sql', label: 'Cloud SQL' },
      { slug: 'firestore', label: 'Firestore' },
      { slug: 'bigquery', label: 'BigQuery' },
      { slug: 'spanner', label: 'Spanner' },
      { slug: 'bigtable', label: 'Bigtable' },
      { slug: 'memorystore', label: 'Memorystore' },
    ],
    Storage: [
      { slug: 'cloud_storage', label: 'Cloud Storage' },
      { slug: 'filestore', label: 'Filestore' },
      { slug: 'persistent_disk', label: 'Persistent Disk' },
    ],
    'AI/ML': [
      { slug: 'vertex_ai', label: 'Vertex AI' },
      { slug: 'dialogflow', label: 'Dialogflow' },
      { slug: 'document_ai', label: 'Document AI' },
      { slug: 'speech_to_text', label: 'Speech-to-Text' },
      { slug: 'translate', label: 'Translation' },
    ],
    Analytics: [
      { slug: 'dataflow', label: 'Dataflow' },
      { slug: 'dataproc', label: 'Dataproc' },
      { slug: 'dataplex', label: 'Dataplex' },
      { slug: 'composer', label: 'Cloud Composer' },
      { slug: 'pubsub', label: 'Pub/Sub' },
    ],
    Security: [
      { slug: 'iam', label: 'IAM' },
      { slug: 'secret_manager', label: 'Secret Manager' },
      { slug: 'kms', label: 'Cloud KMS' },
      { slug: 'security_command_center', label: 'Security Command Center' },
      { slug: 'identity_platform', label: 'Identity Platform' },
    ],
  },
  azure: {
    Compute: [
      { slug: 'virtual_machines', label: 'Virtual Machines' },
      { slug: 'aks', label: 'AKS' },
      { slug: 'container_apps', label: 'Container Apps' },
      { slug: 'functions', label: 'Functions' },
      { slug: 'app_service', label: 'App Service' },
      { slug: 'batch', label: 'Batch' },
    ],
    Networking: [
      { slug: 'virtual_network', label: 'Virtual Network' },
      { slug: 'azure_dns', label: 'Azure DNS' },
      { slug: 'app_gateway', label: 'Application Gateway' },
      { slug: 'load_balancer', label: 'Load Balancer' },
      { slug: 'front_door', label: 'Front Door' },
      { slug: 'expressroute', label: 'ExpressRoute' },
      { slug: 'vpn_gateway', label: 'VPN Gateway' },
    ],
    Database: [
      { slug: 'azure_sql', label: 'Azure SQL' },
      { slug: 'cosmos_db', label: 'Cosmos DB' },
      { slug: 'postgresql', label: 'PostgreSQL' },
      { slug: 'mysql', label: 'MySQL' },
      { slug: 'mariadb', label: 'MariaDB' },
      { slug: 'redis_cache', label: 'Redis Cache' },
    ],
    Storage: [
      { slug: 'blob_storage', label: 'Blob Storage' },
      { slug: 'file_storage', label: 'Azure Files' },
      { slug: 'queue_storage', label: 'Queue Storage' },
      { slug: 'disk_storage', label: 'Managed Disks' },
    ],
    'AI/ML': [
      { slug: 'azure_openai', label: 'Azure OpenAI' },
      { slug: 'cognitive_search', label: 'Cognitive Search' },
      { slug: 'machine_learning', label: 'Machine Learning' },
      { slug: 'bot_service', label: 'Bot Service' },
      { slug: 'cognitive_services', label: 'Cognitive Services' },
    ],
    Analytics: [
      { slug: 'synapse', label: 'Synapse Analytics' },
      { slug: 'data_factory', label: 'Data Factory' },
      { slug: 'databricks', label: 'Databricks' },
      { slug: 'event_hubs', label: 'Event Hubs' },
      { slug: 'stream_analytics', label: 'Stream Analytics' },
    ],
    Security: [
      { slug: 'key_vault', label: 'Key Vault' },
      { slug: 'entra_id', label: 'Entra ID' },
      { slug: 'sentinel', label: 'Sentinel' },
      { slug: 'defender', label: 'Defender for Cloud' },
    ],
  },
  databricks: {
    Workspace: [
      { slug: 'databricks_cluster', label: 'Cluster' },
      { slug: 'databricks_job', label: 'Job' },
      { slug: 'databricks_sql_warehouse', label: 'SQL Warehouse' },
      { slug: 'databricks_notebook', label: 'Notebook' },
      { slug: 'databricks_secret_scope', label: 'Secret Scope' },
      { slug: 'databricks_instance_pool', label: 'Instance Pool' },
    ],
    Governance: [
      { slug: 'databricks_group', label: 'Group' },
      { slug: 'databricks_user', label: 'User' },
      { slug: 'databricks_service_principal', label: 'Service Principal' },
      { slug: 'databricks_permissions', label: 'Permissions' },
    ],
    Data: [
      { slug: 'databricks_catalog', label: 'Unity Catalog' },
      { slug: 'databricks_schema', label: 'Schema' },
      { slug: 'databricks_table', label: 'Table' },
      { slug: 'databricks_external_location', label: 'External Location' },
    ],
  },
  oracle: {
    Compute: [
      { slug: 'oci_core_instance', label: 'Compute Instance' },
      { slug: 'oci_containerengine_cluster', label: 'Container Engine (OKE)' },
      { slug: 'oci_functions_function', label: 'Functions' },
    ],
    Networking: [
      { slug: 'oci_core_vcn', label: 'VCN' },
      { slug: 'oci_core_subnet', label: 'Subnet' },
      { slug: 'oci_core_internet_gateway', label: 'Internet Gateway' },
      { slug: 'oci_core_nat_gateway', label: 'NAT Gateway' },
      { slug: 'oci_core_load_balancer', label: 'Load Balancer' },
    ],
    Database: [
      { slug: 'oci_database_db_system', label: 'DB System' },
      { slug: 'oci_database_autonomous_database', label: 'Autonomous Database' },
      { slug: 'oci_mysql_mysql_db_system', label: 'MySQL HeatWave' },
      { slug: 'oci_nosql_table', label: 'NoSQL Table' },
    ],
    Storage: [
      { slug: 'oci_objectstorage_bucket', label: 'Object Storage' },
      { slug: 'oci_file_storage_file_system', label: 'File Storage' },
      { slug: 'oci_core_volume', label: 'Block Volume' },
    ],
    Security: [
      { slug: 'oci_identity_policy', label: 'IAM Policy' },
      { slug: 'oci_kms_key', label: 'KMS Key' },
      { slug: 'oci_vault_secret', label: 'Vault Secret' },
    ],
  },
  ibm: {
    Compute: [
      { slug: 'ibm_is_instance', label: 'VPC Compute' },
      { slug: 'ibm_container_cluster', label: 'Kubernetes Service' },
      { slug: 'ibm_code_engine_app', label: 'Code Engine' },
      { slug: 'ibm_pi_instance', label: 'Power Systems' },
    ],
    Networking: [
      { slug: 'ibm_is_vpc', label: 'VPC' },
      { slug: 'ibm_is_subnet', label: 'Subnet' },
      { slug: 'ibm_is_public_gateway', label: 'Public Gateway' },
      { slug: 'ibm_cis', label: 'Cloud Internet Services' },
      { slug: 'ibm_dl_gateway', label: 'Direct Link' },
    ],
    Database: [
      { slug: 'ibm_database_postgresql', label: 'PostgreSQL' },
      { slug: 'ibm_database_mysql', label: 'MySQL' },
      { slug: 'ibm_database_mongodb', label: 'MongoDB' },
      { slug: 'ibm_database_redis', label: 'Redis' },
      { slug: 'ibm_database_elasticsearch', label: 'Elasticsearch' },
    ],
    Storage: [
      { slug: 'ibm_cos_bucket', label: 'Object Storage' },
      { slug: 'ibm_is_volume', label: 'Block Storage' },
      { slug: 'ibm_file_storage_share', label: 'File Storage' },
    ],
    Security: [
      { slug: 'ibm_iam_access_group', label: 'IAM Access Group' },
      { slug: 'ibm_kms_key', label: 'Key Protect' },
      { slug: 'ibm_secrets_manager_secret', label: 'Secrets Manager' },
    ],
  },
  alibaba: {
    Compute: [
      { slug: 'alicloud_instance', label: 'ECS Instance' },
      { slug: 'alicloud_managed_kubernetes', label: 'ACK' },
      { slug: 'alicloud_fc_function', label: 'Function Compute' },
      { slug: 'alicloud_ess_scaling_group', label: 'Auto Scaling' },
    ],
    Networking: [
      { slug: 'alicloud_vpc', label: 'VPC' },
      { slug: 'alicloud_vswitch', label: 'vSwitch' },
      { slug: 'alicloud_nat_gateway', label: 'NAT Gateway' },
      { slug: 'alicloud_slb_load_balancer', label: 'SLB' },
      { slug: 'alicloud_alb_load_balancer', label: 'ALB' },
      { slug: 'alicloud_cen_instance', label: 'CEN' },
    ],
    Database: [
      { slug: 'alicloud_db_instance', label: 'RDS' },
      { slug: 'alicloud_polardb_cluster', label: 'PolarDB' },
      { slug: 'alicloud_kvstore_instance', label: 'Redis' },
      { slug: 'alicloud_mongodb_instance', label: 'MongoDB' },
    ],
    Storage: [
      { slug: 'alicloud_oss_bucket', label: 'OSS Bucket' },
      { slug: 'alicloud_nas_file_system', label: 'NAS' },
      { slug: 'alicloud_disk', label: 'Cloud Disk' },
    ],
    'AI/ML': [
      { slug: 'alicloud_pai_workspace', label: 'PAI Workspace' },
      { slug: 'alicloud_maxcompute_project', label: 'MaxCompute' },
    ],
    Security: [
      { slug: 'alicloud_ram_user', label: 'RAM User' },
      { slug: 'alicloud_kms_key', label: 'KMS' },
      { slug: 'alicloud_waf_instance', label: 'WAF' },
    ],
  },
};

interface Account {
  id: number;
  provider: string;
  account_ref: string;
  cloud_account_id: string | null;
  env: string;
}

export function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // ---------- KPIs ----------
  const [pendingCount, setPendingCount] = useState(0);
  const [inFlightCount, setInFlightCount] = useState(0);
  const [monthlySpend, setMonthlySpend] = useState(0);

  // ---------- recent activity ----------
  const [recent, setRecent] = useState<any[]>([]);

  // ---------- accounts (for submit form) ----------
  const [accounts, setAccounts] = useState<Account[]>([]);

  // ---------- submit form ----------
  const [provider, setProvider] = useState('');
  const [category, setCategory] = useState('All');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [accountId, setAccountId] = useState('');
  const [workflowId, setWorkflowId] = useState<number | null>(null);
  const [nlp, setNlp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refresh = () => {
    if (!user) return;
    Promise.all([
      api.listRequests(user.tenant_id, { status: 'awaiting_approval', page: 1, limit: 1 })
        .catch(() => ({ total: 0 })),
      api.listRequests(user.tenant_id, { status: 'applying', page: 1, limit: 1 })
        .catch(() => ({ total: 0 })),
      api.tenantFinance(user.tenant_id, 30).catch(() => ({ total_cost: 0 })),
      api.listRequests(user.tenant_id, { page: 1, limit: 5 }).catch(() => ({ items: [] })),
      api.listAccounts(user.tenant_id, { page: 1, limit: 100 }).catch(() => ({ items: [] })),
    ]).then(([pend, fl, fin, recentRes, acc]) => {
      setPendingCount((pend as any).total ?? 0);
      setInFlightCount((fl as any).total ?? 0);
      setMonthlySpend((fin as any).total_cost ?? 0);
      setRecent((recentRes as any).items ?? []);
      setAccounts(((acc as any).items ?? []) as Account[]);
    }).catch((e) => setError(e.message));
  };

  useEffect(() => { refresh(); }, [user]);

  if (!user) return null;
  const canSubmit = user.role === 'admin' || user.role === 'member';

  const filteredAccounts = provider
    ? accounts.filter((a) => a.provider === provider && a.cloud_account_id)
    : accounts.filter((a) => a.cloud_account_id);

  const categories = ['All', ...(provider ? Object.keys(SERVICES[provider] || {}) : [])];
  const visibleServices: { slug: string; label: string }[] = (() => {
    if (!provider) return [];
    const groups = SERVICES[provider] || {};
    const out: { slug: string; label: string }[] = [];
    Object.keys(groups).forEach((cat) => {
      if (category !== 'All' && category !== cat) return;
      groups[cat].forEach((s) => out.push(s));
    });
    return out;
  })();

  const toggle = (slug: string) => {
    setSelected((prev) => ({ ...prev, [slug]: !prev[slug] }));
  };

  const buildTemplate = () => {
    const keys = Object.keys(selected).filter((k) => selected[k]);
    if (!keys.length) {
      setError('Pick at least one service first.');
      return;
    }
    const all = Object.values(SERVICES[provider]).flat();
    const labels = keys.map((k) => all.find((s) => s.slug === k)?.label ?? k);
    const lines = [
      `Create the following resources in ${provider.toUpperCase()} for the <DEV|UAT|PROD> environment:`,
      '',
      ...labels.map((l, i) => `${i + 1}. ${l} — <configure: name, size/tier, region, tags>`),
      '',
      'Place all resources in region <region>. Apply tags: team=<team-name>.',
    ];
    setNlp(lines.join('\n'));
    setError('');
    setMessage('Template built. Replace the <angle brackets> before submitting.');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nlp.trim() || !accountId) return;
    setSubmitting(true);
    setError('');
    setMessage('');
    try {
      const res = await api.submitRequest(
        user.tenant_id,
        parseInt(accountId),
        nlp.trim(),
        workflowId ?? undefined,
      );
      setMessage(
        `Request ${res.request_id} queued — ${res.total_steps} step${res.total_steps === 1 ? '' : 's'}. ` +
        `Redirecting to Requests…`
      );
      setNlp('');
      setSelected({});
      setTimeout(refresh, 1500);
      setTimeout(() => navigate('/requests?state=all'), 1200);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const selectedCount = Object.values(selected).filter(Boolean).length;

  return (
    <>
      <div className="row">
        <div>
          <h1 className="h1">Good morning, {user.email.split('@')[0]}</h1>
          <p className="sub">Here's what needs your attention today.</p>
        </div>
      </div>

      {/* ======================= KPI SIGNAL CARDS ======================= */}
      <div className="grid-3" style={{ marginBottom: 24 }}>
        <Link
          to="/requests?state=awaiting_approval"
          className="kpi"
          style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
        >
          <div className="kpi-l">Awaiting approval</div>
          <div className="kpi-v" style={{ color: pendingCount > 0 ? '#dc2626' : '#0f172a' }}>
            {pendingCount}
          </div>
          <div className="kpi-t" style={{ color: '#4f46e5', fontWeight: 500 }}>
            {pendingCount > 0 ? 'Review →' : 'All clear'}
          </div>
        </Link>

        <Link to="/finance" className="kpi" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
          <div className="kpi-l">Monthly spend (last 30 days)</div>
          <div className="kpi-v">${monthlySpend.toFixed(0)}</div>
          <div className="kpi-t" style={{ color: '#4f46e5', fontWeight: 500 }}>
            Finance →
          </div>
        </Link>

        <div className="kpi">
          <div className="kpi-l">Requests in flight</div>
          <div className="kpi-v">{inFlightCount}</div>
          <div className="kpi-t" style={{ color: '#64748b' }}>
            {inFlightCount > 0 ? 'Running now' : 'Nothing running'}
          </div>
        </div>
      </div>

      {/* ======================= SUBMIT FORM ======================= */}
      <div className="card">
        <h2 className="card-h">Describe what you want to build</h2>
        <p className="card-s">
          Pick a cloud, pick services, choose the target account and workflow, then submit.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <CloudSelect
            value={provider}
            onChange={(value) => {
              setProvider(value);
              setCategory('All');
              setSelected({});
              setAccountId('');
            }}
            placeholder="— Cloud provider —"
            options={[
              { value: 'aws', label: 'AWS', provider: 'aws' },
              { value: 'gcp', label: 'GCP', provider: 'gcp' },
              { value: 'azure', label: 'Azure', provider: 'azure' },
              { value: 'databricks', label: 'Databricks', provider: 'databricks' },
              { value: 'oracle', label: 'Oracle Cloud', provider: 'oracle' },
              { value: 'ibm', label: 'IBM Cloud', provider: 'ibm' },
              { value: 'alibaba', label: 'Alibaba Cloud', provider: 'alibaba' },
            ]}
            minWidth={200}
          />
          {provider && (
            <button
              className="btn"
              type="button"
              onClick={() => { setProvider(''); setCategory('All'); setSelected({}); setAccountId(''); }}
            >
              Clear
            </button>
          )}
        </div>

        {provider && (
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, background: '#fafbfc', marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className="btn btn-sm"
                  style={{
                    background: category === c ? '#4f46e5' : '#fff',
                    color: category === c ? '#fff' : '#64748b',
                    borderColor: category === c ? '#4f46e5' : '#e5e7eb',
                  }}
                >
                  {c}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 240, overflowY: 'auto', padding: '4px 0' }}>
              {visibleServices.map((s) => {
                const active = selected[s.slug];
                return (
                  <button
                    key={s.slug}
                    type="button"
                    onClick={() => toggle(s.slug)}
                    className="btn btn-sm"
                    style={{
                      background: active ? '#4f46e5' : '#fff',
                      color: active ? '#fff' : '#334155',
                      borderColor: active ? '#4f46e5' : '#e5e7eb',
                      borderRadius: 999,
                    }}
                  >
                    {active ? '✓ ' : ''}{s.label}
                  </button>
                );
              })}
              {visibleServices.length === 0 && (
                <p className="muted" style={{ fontSize: 12 }}>No services in this category.</p>
              )}
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn btn-sm btn-primary"
                type="button"
                onClick={buildTemplate}
                disabled={selectedCount === 0}
              >
                Build request from {selectedCount} selection{selectedCount === 1 ? '' : 's'}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                {selectedCount === 0 ? 'Nothing selected yet.' : `${selectedCount} service(s) selected.`}
              </span>
            </div>
          </div>
        )}

        <form onSubmit={submit}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 12 }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Target account</label>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
                <option value="">— pick an account —</option>
                {filteredAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.account_ref} · {a.provider.toUpperCase()} · {a.env}
                  </option>
                ))}
              </select>
              {filteredAccounts.length === 0 && (
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  {provider
                    ? `No verified ${provider.toUpperCase()} accounts. Register one in Cloud Setup.`
                    : 'Pick a provider above, or add an account in Cloud Setup.'}
                </div>
              )}
            </div>

            <div className="field" style={{ margin: 0 }}>
              <WorkflowPicker value={workflowId} onChange={setWorkflowId} />
            </div>
          </div>

          <div className="field">
            <label>Request</label>
            <textarea
              rows={5}
              value={nlp}
              onChange={(e) => setNlp(e.target.value)}
              placeholder="Or type your request in plain English…"
              required
            />
          </div>

          <button
            className="btn btn-primary"
            type="submit"
            disabled={submitting || !canSubmit || !accountId || !nlp.trim()}
          >
            {submitting ? 'Submitting…' : 'Submit for approval'}
          </button>

          {message && <div className="ok-box" style={{ marginTop: 12 }}>{message}</div>}
          {error && <div className="error-text">{error}</div>}
        </form>
      </div>

      {/* ======================= RECENT ACTIVITY ======================= */}
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <div>
            <h2 className="card-h" style={{ margin: 0 }}>Recent activity</h2>
            <p className="card-s" style={{ margin: '2px 0 0' }}>
              Your last few requests, regardless of state.
            </p>
          </div>
          <Link to="/requests?state=all" className="btn btn-sm">View all →</Link>
        </div>

        {recent.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>No activity yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Status</th>
                  <th>Step</th>
                  <th>Account</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {recent.slice(0, 5).map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontSize: 13 }}>
                      {r.nlp_text?.slice(0, 50)}…{' '}
                      <span className="muted" style={{ fontSize: 11 }}>#{r.id}</span>
                    </td>
                    <td>
                      <span className={`tag tag-${
                        r.status === 'applied' || r.status === 'completed' ? 'green' :
                        r.status === 'failed' ? 'red' :
                        r.status === 'awaiting_approval' ? 'amber' :
                        r.status === 'applying' ? 'blue' : 'gray'
                      }`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="muted" style={{ fontSize: 11 }}>
                      {r.total_steps > 0
                        ? `${Math.min(r.current_step + 1, r.total_steps)}/${r.total_steps}`
                        : '—'}
                    </td>
                    <td className="muted" style={{ fontSize: 11 }}>
                      {r.account_id}
                    </td>
                    <td className="muted" style={{ fontSize: 11 }}>
                      {r.created_at ? new Date(r.created_at).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}