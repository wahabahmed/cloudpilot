import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { Pagination } from '../components/Pagination';

export function Teams() {
  const { user } = useAuth();

  // ---------- teams pagination ----------
  const [teams, setTeams] = useState<any[]>([]);
  const [teamPage, setTeamPage] = useState(1);
  const [teamTotal, setTeamTotal] = useState(0);
  const [teamPages, setTeamPages] = useState(1);
  const [teamSearch, setTeamSearch] = useState('');

  // ---------- users pagination ----------
  const [users, setUsers] = useState<any[]>([]);
  const [userPage, setUserPage] = useState(1);
  const [userTotal, setUserTotal] = useState(0);
  const [userPages, setUserPages] = useState(1);
  const [userSearch, setUserSearch] = useState('');

  // ---------- selection ----------
  const [selectedTeam, setSelectedTeam] = useState<number | null>(null);

  // ---------- debounced search values ----------
  const [teamQuery, setTeamQuery] = useState('');
  const [userQuery, setUserQuery] = useState('');

  useEffect(() => {
    const t = setTimeout(() => { setTeamQuery(teamSearch.trim()); setTeamPage(1); }, 300);
    return () => clearTimeout(t);
  }, [teamSearch]);

  useEffect(() => {
    const t = setTimeout(() => { setUserQuery(userSearch.trim()); setUserPage(1); }, 300);
    return () => clearTimeout(t);
  }, [userSearch]);

  // ---------- form state ----------
  const [newTeamName, setNewTeamName] = useState('');
  const [newUser, setNewUser] = useState({
    email: '',
    name: '',
    password: '',
    team_id: '',
    role: 'member',
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const refresh = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [t, u] = await Promise.all([
        api.listTeams(user.tenant_id, {
          page: teamPage,
          limit: 10,
          search: teamQuery || undefined,
        }),
        (user.role === 'admin' || user.role === 'member') && selectedTeam
          ? api.listUsers(user.tenant_id, {
              page: userPage,
              limit: 10,
              team_id: selectedTeam,
              search: userQuery || undefined,
            })
          : Promise.resolve({ items: [], total: 0, page: 1, pages: 1, limit: 10 }),
      ]);

      setTeams(t.items);
      setTeamTotal(t.total);
      setTeamPages(t.pages);

      setUsers(u.items);
      setUserTotal(u.total);
      setUserPages(u.pages);

      if (!selectedTeam && t.items.length) {
        setSelectedTeam(t.items[0].id);
      } else if (
        selectedTeam &&
        !t.items.find((x: any) => x.id === selectedTeam) &&
        t.items.length
      ) {
        // Don't auto-switch selection when the current team isn't on the
        // visible page only because of a search filter — that would thrash.
        if (!teamQuery) setSelectedTeam(t.items[0].id);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [user, teamPage, userPage, selectedTeam, teamQuery, userQuery]);

  if (!user) return null;

  const handleTeamPageChange = (newPage: number) => {
    setTeamPage(newPage);
    setUserPage(1);
  };

  const handleSelectTeam = (teamId: number) => {
    setSelectedTeam(teamId);
    setUserSearch('');
    setUserPage(1);
  };

  // ---------- create ----------
  const createTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setMessage('');
    if (!newTeamName.trim()) return;
    try {
      await api.createTeam(user.tenant_id, newTeamName.trim());
      setNewTeamName('');
      setMessage('Team created.');
      setTeamSearch('');
      setTeamPage(1);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setMessage('');
    try {
      await api.createUser(
        user.tenant_id,
        newUser.email,
        newUser.name,
        newUser.password,
        newUser.team_id ? parseInt(newUser.team_id) : undefined,
        newUser.role
      );
      setNewUser({ email: '', name: '', password: '', team_id: '', role: 'member' });
      setMessage('User created.');
      setUserPage(1);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ---------- delete ----------
  const handleDeleteTeam = async (team: any) => {
    const ok = window.confirm(
      `Delete team "${team.name}"?\n\n` +
      `• The team will be hidden from all listings.\n` +
      `• Every member of this team will be blocked from logging in.\n` +
      `• No data is physically removed — you can still audit history.`
    );
    if (!ok) return;
    setError(''); setMessage('');
    try {
      await api.deleteTeam(team.id);
      setMessage(`Team "${team.name}" deleted.`);
      if (selectedTeam === team.id) setSelectedTeam(null);
      if (teams.length === 1 && teamPage > 1) setTeamPage(teamPage - 1);
      else refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleDeleteUser = async (u: any) => {
    const ok = window.confirm(
      `Delete user "${u.name}" (${u.email})?\n\n` +
      `• They will no longer be able to log in.\n` +
      `• Their existing session will be invalidated immediately.\n` +
      `• No data is physically removed.`
    );
    if (!ok) return;
    setError(''); setMessage('');
    try {
      await api.deleteUser(u.id);
      setMessage(`User "${u.name}" deleted.`);
      if (users.length === 1 && userPage > 1) setUserPage(userPage - 1);
      else refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const selectedTeamName = selectedTeam
    ? teams.find((t) => t.id === selectedTeam)?.name
    : null;

  return (
    <>
      <div className="row">
        <div>
          <h1 className="h1">Teams &amp; Users</h1>
          <p className="sub">Members, roles, and team structure.</p>
        </div>
      </div>

      <div className="grid-2">
        {/* ======================= TEAMS ======================= */}
        <div className="card">
          <h2 className="card-h">Teams ({teamTotal})</h2>

          <div className="field" style={{ marginBottom: 12 }}>
            <input
              placeholder="Search teams by name…"
              value={teamSearch}
              onChange={(e) => setTeamSearch(e.target.value)}
            />
          </div>

          {loading ? (
            <p className="muted" style={{ fontSize: 13 }}>Loading…</p>
          ) : teams.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>
              {teamQuery ? `No teams match "${teamQuery}".` : 'No teams yet.'}
            </p>
          ) : (
            <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: 1 }}></th>
                </tr>
              </thead>
              <tbody>
                {teams.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className={`btn btn-sm ${selectedTeam === t.id ? 'btn-primary' : ''}`}
                        onClick={() => handleSelectTeam(t.id)}
                      >
                        {selectedTeam === t.id ? 'Selected' : 'View'}
                      </button>
                      {user.role === 'admin' && (
                        <button
                          className="btn btn-sm btn-danger"
                          style={{ marginLeft: 8 }}
                          onClick={() => handleDeleteTeam(t)}
                          title="Soft-deletes the team and disables all its members"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}

          <Pagination
            page={teamPage}
            pages={teamPages}
            total={teamTotal}
            limit={10}
            onChange={handleTeamPageChange}
          />

          {user.role === 'admin' && (
            <form onSubmit={createTeam} style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <input
                placeholder="New team name"
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
              />
              <button className="btn btn-primary" type="submit">+ Add</button>
            </form>
          )}
        </div>

        {/* ======================= USERS ======================= */}
        <div className="card">
          <h2 className="card-h">{selectedTeamName ?? 'Select a team'}</h2>
          <p className="card-s">
            {selectedTeam
              ? `${userTotal} member${userTotal === 1 ? '' : 's'}${userQuery ? ` matching "${userQuery}"` : ''}`
              : 'Pick a team on the left to view its members.'}
          </p>

          {selectedTeam && (
            <div className="field" style={{ marginBottom: 12 }}>
              <input
                placeholder="Search members by name or email…"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
              />
            </div>
          )}

          {!selectedTeam ? (
            <p className="muted" style={{ fontSize: 13 }}>
              Select a team to view its members.
            </p>
          ) : loading ? (
            <p className="muted" style={{ fontSize: 13 }}>Loading…</p>
          ) : users.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>
              {userQuery
                ? `No members match "${userQuery}".`
                : 'No users in this team yet.'}
            </p>
          ) : (
            <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th style={{ width: 1 }}></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="member">
                        <span className="avatar">
                          {u.name?.[0]?.toUpperCase() ?? '?'}
                        </span>
                        {u.name}
                      </div>
                    </td>
                    <td className="muted">{u.email}</td>
                    <td>
                      <span className={`role role-${u.role}`}>{u.role}</span>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {user.role === 'admin' && u.id !== user.user_id && (
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => handleDeleteUser(u)}
                          title="Soft-deletes this user — they can no longer log in"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}

          <Pagination
            page={userPage}
            pages={userPages}
            total={userTotal}
            limit={10}
            onChange={setUserPage}
          />
        </div>
      </div>

      {user.role === 'admin' && (
        <div className="card">
          <h2 className="card-h">Create user</h2>
          <p className="card-s">Add a user to this tenant and assign a role.</p>
          <form onSubmit={createUser}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div className="field">
                <label>Email</label>
                <input
                  type="email"
                  value={newUser.email}
                  onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                  required
                />
              </div>
              <div className="field">
                <label>Name</label>
                <input
                  value={newUser.name}
                  onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
                  required
                />
              </div>
              <div className="field">
                <label>Password</label>
                <input
                  type="password"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  required
                />
              </div>
              <div className="field">
                <label>Role</label>
                <select
                  value={newUser.role}
                  onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>
              <div className="field">
                <label>Team</label>
                <select
                  value={newUser.team_id}
                  onChange={(e) => setNewUser({ ...newUser, team_id: e.target.value })}
                >
                  <option value="">— none —</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <button className="btn btn-primary" type="submit">Create user</button>
            {message && <div className="ok-box" style={{ marginTop: 12 }}>{message}</div>}
            {error && <div className="error-text">{error}</div>}
          </form>
        </div>
      )}
    </>
  );
}