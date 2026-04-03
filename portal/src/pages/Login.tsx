import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithRedirect, getCurrentUser } from 'aws-amplify/auth';
import { Flame, Zap, Shield, Globe } from 'lucide-react';

export function Login() {
  const navigate = useNavigate();

  useEffect(() => {
    getCurrentUser()
      .then(() => navigate('/dashboard', { replace: true }))
      .catch(() => { /* Not signed in — stay on login page */ });
  }, [navigate]);

  return (
    <div className="min-h-screen bg-obsidian-950 bg-mesh flex">
      {/* Left panel — branding */}
      <div className="hidden lg:flex flex-col justify-between w-[420px] bg-obsidian-900 border-r border-border p-10">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-lava-500/10 border border-lava-500/30 flex items-center justify-center">
            <Flame size={18} className="text-lava-400" />
          </div>
          <span className="font-display font-bold text-lg text-text tracking-wide">LavaVPS</span>
        </div>

        {/* Features */}
        <div className="space-y-6">
          <div>
            <h2 className="font-display text-2xl font-bold text-text leading-tight">
              Deploy AI agents that<br />
              <span className="text-gradient-lava">actually persist.</span>
            </h2>
            <p className="mt-3 text-sm text-muted leading-relaxed">
              BYOK managed hosting for OpenClaw agents on AWS.
              Your keys, your agents, your data.
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

      {/* Right panel — sign in */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="flex items-center justify-center gap-2 mb-8 lg:hidden">
            <div className="w-8 h-8 rounded-xl bg-lava-500/10 border border-lava-500/30 flex items-center justify-center">
              <Flame size={16} className="text-lava-400" />
            </div>
            <span className="font-display font-bold text-text">LavaVPS</span>
          </div>

          <div className="card p-8">
            <h1 className="text-xl font-bold text-text mb-1">Sign in</h1>
            <p className="text-sm text-muted mb-8">Access your AI agent dashboard</p>

            {/* Cognito hosted UI — handles login, registration, MFA, forgot password */}
            <button
              className="btn-primary w-full py-3 text-sm"
              onClick={() => signInWithRedirect()}
            >
              Continue with LavaVPS
            </button>

            <div className="mt-6 pt-6 border-t border-border">
              <p className="text-xs text-muted text-center">
                Don't have an account?{' '}
                <button
                  className="text-lava-400 hover:text-lava-300 transition-colors"
                  onClick={() => signInWithRedirect()}
                >
                  Sign up — 3-day free trial
                </button>
              </p>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-center gap-4">
            <a href="https://lavavps.ai/privacy" className="text-xs text-muted hover:text-text transition-colors">Privacy</a>
            <span className="text-muted/30">·</span>
            <a href="https://lavavps.ai/terms"   className="text-xs text-muted hover:text-text transition-colors">Terms</a>
            <span className="text-muted/30">·</span>
            <a href="https://discord.gg/lavavps" className="text-xs text-muted hover:text-text transition-colors">Discord</a>
          </div>
        </div>
      </div>
    </div>
  );
}
