import { getCurrentUser } from 'aws-amplify/auth';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth }        from '@/hooks/useAuth';
import { Layout }         from '@/components/Layout';
import { Login }          from '@/pages/Login';
import { Dashboard }      from '@/pages/Dashboard';
import { Chat }           from '@/pages/Chat';
import { NewAgentWizard } from '@/pages/NewAgentWizard';
import { AgentConfig }    from '@/pages/AgentConfig';
import { FileManager }    from '@/pages/FileManager';
import { Jobs }           from '@/pages/Jobs';
import { Billing }        from '@/pages/Billing';
import { Account }        from '@/pages/Account';
import { Flame }          from 'lucide-react';

// ── Auth-required wrapper ─────────────────────────────────────────────────────
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { loading, authenticated } = useAuth();

  if (loading) {
    return (
      <div className="fixed inset-0 bg-obsidian-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-lava-500/10 border border-lava-500/30 flex items-center justify-center animate-pulse-lava">
            <Flame size={20} className="text-lava-400" />
          </div>
          <p className="text-sm text-muted">Loading...</p>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/login"         element={<Login />} />
        <Route path="/auth/callback" element={<AuthCallback />} />

        {/* Protected */}
        <Route path="/" element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }>
          <Route index             element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard"  element={<Dashboard />} />
          <Route path="chat"       element={<Chat />} />
          <Route path="chat/:agentId" element={<Chat />} />
          <Route path="new-agent"  element={<NewAgentWizard />} />
          <Route path="config/:agentId" element={<AgentConfig />} />
          <Route path="files"      element={<FileManager />} />
          <Route path="files/:agentId" element={<FileManager />} />
          <Route path="jobs"       element={<Jobs />} />
          <Route path="jobs/:agentId" element={<Jobs />} />
          <Route path="billing"    element={<Billing />} />
          <Route path="settings"   element={<Account />} />
          <Route path="account"    element={<Account />} />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

// Cognito OAuth callback handler — waits for token exchange then redirects
function AuthCallback() {
  const navigate = useNavigate();
  useEffect(() => {
    // Amplify processes the OAuth code automatically on mount.
    // Poll until authenticated then redirect to dashboard.
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      try {
        await getCurrentUser();
        clearInterval(interval);
        navigate('/dashboard', { replace: true });
      } catch {
        if (attempts > 20) { // 10 seconds max
          clearInterval(interval);
          navigate('/login', { replace: true });
        }
      }
    }, 500);
    return () => clearInterval(interval);
  }, [navigate]);

  return (
    <div className="fixed inset-0 bg-obsidian-950 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-10 h-10 rounded-xl bg-lava-500/10 border border-lava-500/30 flex items-center justify-center animate-pulse-lava">
          <Flame size={20} className="text-lava-400" />
        </div>
        <p className="text-sm text-muted">Signing in...</p>
      </div>
    </div>
  );
}
