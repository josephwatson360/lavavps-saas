import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signIn } from 'aws-amplify/auth';
import { Flame, Zap, Shield, Globe, Eye, EyeOff, Loader2 } from 'lucide-react';

export function Login() {
  const navigate  = useNavigate();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await signIn({ username: email, password });
      navigate('/dashboard', { replace: true });
    } catch (err: unknown) {
      const msg = (err as Error).message ?? 'Sign in failed';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-obsidian-950 bg-mesh flex">
      {/* Left panel */}
      <div className="hidden lg:flex flex-col justify-between w-[420px] bg-obsidian-900 border-r border-border p-10">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-lava-500/10 border border-lava-500/30 flex items-center justify-center">
            <Flame size={18} className="text-lava-400" />
          </div>
          <span className="font-display font-bold text-lg text-text tracking-wide">LavaVPS</span>
        </div>
        <div className="space-y-6">
          <div>
            <h2 className="font-display text-2xl font-bold text-text leading-tight">
              Deploy AI agents that<br />
              <span className="text-gradient-lava">actually persist.</span>
            </h2>
            <p className="mt-3 text-sm text-muted leading-relaxed">
              BYOK managed hosting for OpenClaw agents on AWS. Your keys, your agents, your data.
            </p>
          </div>
          <div className="space-y-4">
            {[
              { icon: Shield, text: 'Your API keys stored in AWS Secrets Manager. Never logged. Never resold.' },
              { icon: Zap,    text: 'Agents stay alive between sessions with persistent EFS storage.' },
              { icon: Globe,  text: 'Discord, Telegram, and WhatsApp integrations built in.' },
            ].map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-lg bg-lava-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Icon size={13} className="text-lava-400" />
                </div>
                <p className="text-sm text-muted leading-relaxed">{text}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted/50">© 2026 LavaVPS Inc. All rights reserved.</p>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="flex items-center justify-center gap-2 mb-8 lg:hidden">
            <div className="w-8 h-8 rounded-xl bg-lava-500/10 border border-lava-500/30 flex items-center justify-center">
              <Flame size={16} className="text-lava-400" />
            </div>
            <span className="font-display font-bold text-text">LavaVPS</span>
          </div>

          <div className="card p-8">
            <h1 className="text-xl font-bold text-text mb-1">Sign in</h1>
            <p className="text-sm text-muted mb-6">Access your AI agent dashboard</p>

            <form onSubmit={handleSignIn} className="space-y-4">
              <div>
                <label className="label">Email</label>
                <input
                  type="email"
                  className="input"
                  placeholder="you@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div>
                <label className="label">Password</label>
                <div className="relative">
                  <input
                    type={showPw ? 'text' : 'password'}
                    className="input pr-10"
                    placeholder="Your password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text"
                    onClick={() => setShowPw(!showPw)}
                  >
                    {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              {error && (
                <p className="text-xs text-red-400 bg-red-900/10 border border-red-900/30 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}

              <button
                type="submit"
                className="btn-primary w-full py-3"
                disabled={loading}
              >
                {loading ? <><Loader2 size={14} className="animate-spin" /> Signing in...</> : 'Sign In'}
              </button>
            </form>

            <div className="mt-6 pt-6 border-t border-border">
              <p className="text-xs text-muted text-center">
                Don't have an account?{' '}
                <span className="text-lava-400">
                  Sign up via lavavps.ai after launch
                </span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
