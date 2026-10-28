import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export function Login() {
  const { token, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  if (token) return <Navigate to="/dashboard" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await login(email, password);
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="hero">
      <div className="login">
        <div className="login-l">
          <div className="brand" style={{ padding: '0 0 32px' }}>
            <div className="brand-mark">CP</div>
            <div className="brand-name">CloudPilot</div>
          </div>
          <h2 style={{ fontSize: 22, fontWeight: 600, margin: '0 0 12px', lineHeight: 1.35 }}>
            Your co-pilot for multi-cloud infrastructure.
          </h2>
          <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.7, margin: '0 0 28px' }}>
            Describe what you need in plain English. CloudPilot turns it into a reviewed Terraform plan, executes it with approval gates, and keeps every account's state isolated.
          </p>
        </div>
        <div className="login-r">
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 4px' }}>Welcome back</h2>
          <p className="muted" style={{ fontSize: 13, margin: '0 0 24px' }}>Sign in to your workspace.</p>
          <form onSubmit={submit}>
            <div className="field">
              <label>Work email</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
            </div>
            <div className="field">
              <label>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
            </div>
            <button className="btn btn-primary" type="submit" style={{ width: '100%', justifyContent: 'center', padding: 10 }}>
              Sign in
            </button>
            {error && <div className="error-text">{error}</div>}
          </form>
        </div>
      </div>
    </div>
  );
}