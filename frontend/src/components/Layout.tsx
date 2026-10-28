import { useEffect, useState } from 'react';
import { NavLink, Outlet, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { NAV, canAccess, type Role } from '../lib/permissions';

export function Layout() {
  const { user, license, logout } = useAuth();
  const location = useLocation();

  // ---------- responsive drawer ----------
  const [navOpen, setNavOpen] = useState(false);

  // Close the drawer whenever the route changes (user tapped a link)
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  // Lock body scroll while the drawer is open (mobile only)
  useEffect(() => {
    if (navOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [navOpen]);

  // Close on Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const role = user?.role as Role | undefined;

  const licenseInvalid = license && !license.valid;
  const expiringSoon = license && license.valid && (license.days_remaining ?? 999) < 14;

  // Nav items filtered by role.
  const items = NAV.filter((item) => role && item.roles.includes(role));

  // Direct-URL guard: block routes the current role can't hit.
  const currentPath = location.pathname;
  const blocked = role && !canAccess(role, currentPath);

  return (
    <>
      {/* Hamburger button — hidden on desktop, shown below 900px */}
      <button
        type="button"
        className="nav-toggle"
        onClick={() => setNavOpen((v) => !v)}
        aria-label={navOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={navOpen}
        aria-controls="main-nav"
      >
        {navOpen ? '✕' : '☰'}
      </button>

      {/* Backdrop overlay — shown only on mobile when the drawer is open */}
      <div
        className={`nav-backdrop ${navOpen ? 'active' : ''}`}
        onClick={() => setNavOpen(false)}
        aria-hidden="true"
      />

      <div className="shell">
        <nav
          id="main-nav"
          className={`nav ${navOpen ? 'open' : ''}`}
          aria-label="Main navigation"
        >
          <div className="brand">
            <div className="brand-mark">CP</div>
            <div className="brand-name">CloudPilot</div>
          </div>

          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? 'active' : '')}
              onClick={() => setNavOpen(false)}
            >
              {item.label}
            </NavLink>
          ))}

          <div className="nav-foot">
            {user?.tenant_name ?? 'Loading…'}<br />
            <span className={`role role-${user?.role ?? 'viewer'}`} style={{ marginTop: 8 }}>
              {user?.role ?? '…'}
            </span>
            {license?.valid && license.days_remaining !== undefined && (
              <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
                License · {license.days_remaining}d
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <button
                className="btn btn-sm"
                onClick={logout}
                style={{ width: '100%' }}
              >
                Sign out
              </button>
            </div>
          </div>
        </nav>

        <main className="main">
          {licenseInvalid && (
            <div style={{
              background: '#fee2e2', color: '#991b1b', padding: '12px 18px',
              borderRadius: 8, marginBottom: 20, fontSize: 14,
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', gap: 12, flexWrap: 'wrap',
            }}>
              <span>⚠️ License expired. Write operations are disabled.</span>
              <Link to="/license" style={{ color: '#991b1b', fontWeight: 600 }}>
                Upload license →
              </Link>
            </div>
          )}

          {expiringSoon && (
            <div style={{
              background: '#fef3c7', color: '#92400e', padding: '12px 18px',
              borderRadius: 8, marginBottom: 20, fontSize: 14,
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', gap: 12, flexWrap: 'wrap',
            }}>
              <span>⚠️ License expires in {license?.days_remaining} days.</span>
              <Link to="/license" style={{ color: '#92400e', fontWeight: 600 }}>
                Renew →
              </Link>
            </div>
          )}

          {!user ? null : blocked ? (
            <div className="card">
              <h2 className="card-h">Not allowed</h2>
              <p className="muted" style={{ fontSize: 14 }}>
                Your role (<b>{role}</b>) cannot access this page. If you think this is
                a mistake, ask your tenant admin to grant you the <code>admin</code> role.
              </p>
              <Link to="/dashboard" className="btn btn-sm">← Back to dashboard</Link>
            </div>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </>
  );
}