// frontend/src/lib/permissions.ts
//
// Central nav + role map. Mirrors the backend's require_role(...) checks
// in app/main.py. If you change a role on the backend, change it here too.

export type Role = 'roles here';

export type NavItem = {
  to: string;
  label: string;
  /** Roles that can see this nav item AND hit the endpoint. */
  roles: Role[];
};

export const NAV: NavItem[] = [
  { to: '/dashboard',   label: 'Dashboard',   roles: [] },
  { to: '/requests', label: 'Requests', roles: [] },
  { to: '/inventory',   label: 'Inventory',   roles: [] },
  { to: '/pipelines',   label: 'Pipelines',   roles: [] },
  { to: '/workflows',   label: 'Workflows',   roles: [] },
  { to: '/finance',     label: 'Finance',     roles: [] },
  { to: '/cloud-setup', label: 'Cloud Setup', roles: [] },
  { to: '/teams',       label: 'Teams',       roles: [] },
  { to: '/import',      label: 'Import',      roles: [] },
  { to: '/license',     label: 'License',     roles: [] },
];

/**
 * Returns true if `role` can access `to`.
 * Unknown routes (not in NAV) are allowed by default — the page itself
 * is responsible for its own auth, and this avoids false "not allowed"
 * screens for routes you haven't added to NAV yet.
 */
export function canAccess(role: Role | undefined, to: string): boolean {
  if (!role) return false;
  const item = NAV.find((n) => n.to === to);
  if (!item) return true;                 // unknown route — let it through
  return item.roles.includes(role);
}