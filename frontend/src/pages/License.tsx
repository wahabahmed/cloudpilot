import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';

export function License() {
  const { user, license, refreshLicense } = useAuth();
  const [key, setKey] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  if (!user) return null;
  if (user.role !== 'admin') {
    return (
      <div className="card">
        <h2 className="card-h">Admin only</h2>
        <p className="muted" style={{ fontSize: 13 }}>Only admins can manage the license.</p>
      </div>
    );
  }

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setMessage(''); setSaving(true);
    try {
      const res = await api.uploadLicense(key.trim());
      setMessage(`License updated for ${res.customer}. Expires ${new Date(res.expires_at).toLocaleDateString()} (${res.days_remaining} days).`);
      setKey('');
      await refreshLicense();
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
          <h1 className="h1">License</h1>
          <p className="sub">View the current license and upload a renewal.</p>
        </div>
      </div>

      <div className="card">
        <h2 className="card-h">Current license</h2>
        {license && license.valid ? (
          <div className="ok-box">
            <strong>✓ Valid</strong> — {license.customer} · {license.tier} · expires{' '}
            {license.expires_at ? new Date(license.expires_at).toLocaleDateString() : '—'}{' '}
            ({license.days_remaining} days remaining)
          </div>
        ) : (
          <div className="warn-box">
            <strong>No valid license.</strong> All write operations are blocked. Upload a new
            license file below.
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-h">Upload renewal</h2>
        <p className="card-s">
          Paste the license token your vendor emailed you. It takes effect immediately — no
          restart needed.
        </p>
        <form onSubmit={upload}>
          <div className="field">
            <label>License key</label>
            <textarea
              value={key}
              onChange={(e) => setKey(e.target.value)}
              rows={6}
              placeholder="eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9..."
              style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
              required
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? 'Uploading…' : 'Upload license'}
          </button>
          {message && <div className="ok-box" style={{ marginTop: 12 }}>{message}</div>}
          {error && <div className="error-text">{error}</div>}
        </form>
      </div>
    </>
  );
}