import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Inventory } from './pages/Inventory';
import { CloudSetup } from './pages/CloudSetup';
import { Finance } from './pages/Finance';
import { Teams } from './pages/Teams';
import { PipelinesOnboarding } from './pages/PipelinesOnboarding';
import { Workflows } from './pages/Workflows';
import { License } from './pages/License';
import { Import } from './pages/Import';
import { Requests } from './pages/Requests';

function Protected() {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <Layout />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Protected />}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/requests" element={<Requests />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/pipelines" element={<PipelinesOnboarding />} />
            <Route path="/workflows" element={<Workflows />} />
            <Route path="/finance" element={<Finance />} />
            <Route path="/cloud-setup" element={<CloudSetup />} />
            <Route path="/teams" element={<Teams />} />
            <Route path="/license" element={<License />} />
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
            <Route path="/import" element={<Import />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}