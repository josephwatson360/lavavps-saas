import { useState } from 'react';
import { User, Shield, Trash2, Copy, Check } from 'lucide-react';
import { signOut }      from 'aws-amplify/auth';
import { useAuth }      from '@/hooks/useAuth';
import { useStore, toast } from '@/store/useStore';

export function Account() {
  const { tenant }   = useAuth();
  const { agents }   = useStore();
  const [copied, setCopied] = useState(false);

  function copyTenantId() {
    if (!tenant?.tenantId) return;
    navigator.clipboard.writeText(tenant.tenantId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success('Tenant ID copied');
  }

  async function handleDeleteAccount() {
    const confirmation = prompt('Type "DELETE" to confirm account deletion:');
    if (confirmation !== 'DELETE') return;
    toast.error('Account deletion — please contact support@lavavps.ai to complete this process.');
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="font-display text-2xl font-bold text-text">Account Settings</h1>
        <p className="text-sm text-muted mt-1">{tenant?.email}</p>
      </div>

      <div className="space-y-5">
        {/* Profile */}
        <section className="card p-5">
          <div className="flex items-center gap-2 mb-4">
            <User size={14} className="text-muted" />
            <h2 className="text-sm font-semibold text-text">Profile</h2>
          </div>
          <div className="space-y-3">
            <div>
              <label className="label">Email</label>
              <p className="text-sm text-text bg-obsidian-800 border border-border rounded-lg px-3 py-2">
                {tenant?.email || '—'}
              </p>
            </div>
            <div>
              <label className="label">Plan</label>
              <p className="text-sm text-text bg-obsidian-800 border border-border rounded-lg px-3 py-2 capitalize">
                {tenant?.planCode || '—'}
              </p>
            </div>
            <div>
              <label className="label">Tenant ID</label>
              <div className="flex items-center gap-2">
                <p className="flex-1 font-mono text-xs text-muted bg-obsidian-800 border border-border rounded-lg px-3 py-2 truncate">
                  {tenant?.tenantId || '—'}
                </p>
                <button className="btn-secondary p-2" onClick={copyTenantId}>
                  {copied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Security */}
        <section className="card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Shield size={14} className="text-muted" />
            <h2 className="text-sm font-semibold text-text">Security</h2>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 rounded-lg bg-obsidian-800 border border-border">
              <div>
                <p className="text-sm text-text">Password</p>
                <p className="text-xs text-muted">Managed by Cognito</p>
              </div>
              <button
                className="btn-secondary text-xs"
                onClick={() => toast.info('Use the "Forgot Password" flow on the login page to reset your password.')}
              >
                Change
              </button>
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-obsidian-800 border border-border">
              <div>
                <p className="text-sm text-text">Sign Out All Devices</p>
                <p className="text-xs text-muted">Revoke all active sessions</p>
              </div>
              <button
                className="btn-danger text-xs"
                onClick={() => signOut({ global: true })}
              >
                Sign Out All
              </button>
            </div>
          </div>
        </section>

        {/* Stats */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-text mb-3">Usage</h2>
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-obsidian-800 rounded-xl p-3 text-center">
              <p className="text-xs text-muted mb-1">Agents</p>
              <p className="text-lg font-bold text-text">{agents.length}</p>
            </div>
            <div className="bg-obsidian-800 rounded-xl p-3 text-center">
              <p className="text-xs text-muted mb-1">Running</p>
              <p className="text-lg font-bold text-green-400">
                {agents.filter(a => a.status === 'RUNNING').length}
              </p>
            </div>
            <div className="bg-obsidian-800 rounded-xl p-3 text-center">
              <p className="text-xs text-muted mb-1">Plan</p>
              <p className="text-sm font-bold text-text capitalize">{tenant?.planCode}</p>
            </div>
          </div>
        </section>

        {/* Danger zone */}
        <section className="card p-5 border-red-900/20">
          <div className="flex items-center gap-2 mb-4">
            <Trash2 size={14} className="text-red-400" />
            <h2 className="text-sm font-semibold text-red-400">Danger Zone</h2>
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-red-900/10 border border-red-900/30">
            <div>
              <p className="text-sm text-text">Delete Account</p>
              <p className="text-xs text-muted">Permanently delete your account and all agents</p>
            </div>
            <button className="btn-danger text-xs" onClick={handleDeleteAccount}>
              Delete Account
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
