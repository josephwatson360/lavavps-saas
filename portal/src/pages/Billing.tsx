import { useState } from 'react';
import { CreditCard, HardDrive, Plus, ExternalLink, CheckCircle2, Loader2, Settings } from 'lucide-react';
import { billingApi } from '@/api/client';
import { useStore, toast } from '@/store/useStore';

// ─────────────────────────────────────────────────────────────────────────────
// Billing page
//
// - Current plan display + usage
// - Add-on purchases (agents, storage) → Stripe Checkout via backend
// - Plan upgrades → Stripe Checkout via backend
// - Plan downgrades + management (payment, invoices) → Stripe Customer Portal
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_FEATURES: Record<string, string[]> = {
  starter:  ['2 agents', '5 GB storage', '0.25 vCPU / 1 GB RAM', 'Discord + Telegram Channel Integrations', '15-min idle timeout'],
  pro:      ['4 agents', '50 GB storage', '0.5 vCPU / 1 GB RAM', 'Ralph Loop / Auto Tasks', 'Discord + Telegram + WhatsApp Channel Integrations', '30-min idle timeout'],
  business: ['10 agents', '100 GB storage', '1 vCPU / 2 GB RAM', 'All Channel Integrations', 'Audit logs', 'Priority API', '60-min idle timeout'],
};

const STORAGE_ADDONS = [
  { label: '+10 GB', price: '$5',  gb: 10  },
  { label: '+50 GB', price: '$25', gb: 50  },
  { label: '+100 GB', price: '$50', gb: 100 },
];

export function Billing() {
  const { tenant, agents } = useStore();
  const plan      = tenant?.planCode ?? 'starter';
  const features  = PLAN_FEATURES[plan] ?? [];
  const agentMax  = { starter: 2, pro: 4, business: 10 }[plan] ?? 2;
  const usedAgents = agents.length;
  const [loading, setLoading] = useState<string | null>(null);

  async function handleCheckout(type: 'plan' | 'addon_agent' | 'addon_storage', extra?: { planCode?: string; storageGb?: number }) {
    const key = `${type}_${extra?.planCode ?? extra?.storageGb ?? ''}`;
    setLoading(key);
    try {
      const { checkoutUrl } = await billingApi.createCheckout({
        type,
        planCode:  extra?.planCode,
        storageGb: extra?.storageGb,
      });
      window.location.href = checkoutUrl;
    } catch {
      toast.error('Failed to start checkout. Please try again.');
      setLoading(null);
    }
  }

  async function handleManage() {
    setLoading('portal');
    try {
      const { portalUrl } = await billingApi.createPortalSession();
      window.location.href = portalUrl;
    } catch {
      toast.error('Failed to open billing portal. Please try again.');
      setLoading(null);
    }
  }

  function isLoading(key: string) {
    return loading === key;
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="font-display text-2xl font-bold text-text">Billing & Plan</h1>
        <p className="text-sm text-muted mt-1">Manage your subscription and add-ons</p>
      </div>

      {/* Current plan */}
      <div className="card p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-xs text-muted uppercase tracking-wider mb-1">Current Plan</p>
            <h2 className="font-display text-xl font-bold text-text capitalize">{plan}</h2>
          </div>
          <button
            className="btn-secondary text-xs"
            onClick={handleManage}
            disabled={isLoading('portal')}
          >
            {isLoading('portal')
              ? <><Loader2 size={12} className="animate-spin" /> Opening...</>
              : <><Settings size={12} /> Manage Subscription</>}
          </button>
        </div>

        {/* Usage */}
        <div className="grid grid-cols-2 gap-4 mb-5">
          <div className="bg-obsidian-800 rounded-xl p-3">
            <p className="text-xs text-muted mb-1">Agents</p>
            <p className="text-lg font-bold text-text">
              {usedAgents}
              <span className="text-sm font-normal text-muted"> / {agentMax}</span>
            </p>
          </div>
          <div className="bg-obsidian-800 rounded-xl p-3">
            <p className="text-xs text-muted mb-1">Storage Pool</p>
            <p className="text-lg font-bold text-text capitalize">
              {plan === 'starter' ? '5 GB' : plan === 'pro' ? '50 GB' : '100 GB'}
            </p>
          </div>
        </div>

        {/* Features */}
        <div className="grid grid-cols-2 gap-y-2">
          {features.map(f => (
            <div key={f} className="flex items-center gap-2">
              <CheckCircle2 size={12} className="text-green-400 flex-shrink-0" />
              <span className="text-xs text-text">{f}</span>
            </div>
          ))}
        </div>

        {/* Manage note */}
        <div className="mt-4 pt-4 border-t border-border">
          <p className="text-xs text-muted">
            To <strong className="text-text">downgrade</strong> your plan, update payment method, or view invoices, click{' '}
            <button onClick={handleManage} className="text-lava-400 hover:text-lava-300 underline transition-colors">
              Manage Subscription
            </button>{' '}
            — this opens the Stripe Customer Portal where you can make any changes.
          </p>
        </div>
      </div>

      {/* Add-ons */}
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-text mb-3">Add-Ons</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Additional agent */}
          <div className="card p-4">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-lava-500/10 flex items-center justify-center">
                <Plus size={14} className="text-lava-400" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-text">Additional Agent</p>
                <p className="text-xs text-muted mt-0.5">Add one more agent to your account</p>
                <p className="text-sm font-bold text-lava-400 mt-2">$15.99 / month</p>
              </div>
            </div>
            <button
              className="btn-primary w-full mt-4 text-xs py-2"
              onClick={() => handleCheckout('addon_agent')}
              disabled={!!loading}
            >
              {isLoading('addon_agent_')
                ? <><Loader2 size={13} className="animate-spin" /> Opening...</>
                : 'Add Agent'}
            </button>
          </div>

          {/* Storage add-ons */}
          <div className="card p-4">
            <div className="flex items-start gap-3 mb-3">
              <div className="w-8 h-8 rounded-lg bg-blue-900/20 flex items-center justify-center">
                <HardDrive size={14} className="text-blue-400" />
              </div>
              <div>
                <p className="text-sm font-medium text-text">Storage</p>
                <p className="text-xs text-muted">One-time purchase, added to your pool instantly</p>
              </div>
            </div>
            <div className="space-y-2">
              {STORAGE_ADDONS.map(({ label, price, gb }) => (
                <button
                  key={gb}
                  className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-obsidian-800 border border-border hover:border-obsidian-500 transition-all text-left disabled:opacity-50"
                  onClick={() => handleCheckout('addon_storage', { storageGb: gb })}
                  disabled={!!loading}
                >
                  <span className="text-xs text-text">{label}</span>
                  {isLoading(`addon_storage_${gb}`)
                    ? <Loader2 size={12} className="animate-spin text-muted" />
                    : <span className="text-xs font-bold text-text">{price}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Plan upgrades */}
      {plan !== 'business' && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-text mb-3">Upgrade Plan</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {plan === 'starter' && (
              <PlanCard
                name="Pro"
                price="$79/mo"
                features={['4 agents', '50 GB storage', 'Ralph Loop / Auto Tasks', 'Discord + Telegram + WhatsApp Channel Integrations', '30-min idle timeout']}
                onUpgrade={() => handleCheckout('plan', { planCode: 'pro' })}
                loading={isLoading('plan_pro')}
                highlight
              />
            )}
            <PlanCard
              name="Business"
              price="$199/mo"
              features={['10 agents', '100 GB storage', 'All Channel Integrations', '1 vCPU / 2 GB', 'Audit logs', '60-min idle timeout']}
              onUpgrade={() => handleCheckout('plan', { planCode: 'business' })}
              loading={isLoading('plan_business')}
            />
          </div>
        </div>
      )}

      {/* BYOK note */}
      <div className="p-4 rounded-xl border border-border bg-obsidian-800/50">
        <p className="text-xs text-muted leading-relaxed">
          <strong className="text-text">BYOK Model:</strong> LavaVPS never charges for AI token usage.
          You purchase tokens directly from your LLM provider (Anthropic, OpenAI, etc.).
          LavaVPS only charges for platform access. All plans include a 3-day free trial.
        </p>
      </div>
    </div>
  );
}

function PlanCard({ name, price, features, onUpgrade, loading, highlight }: {
  name: string;
  price: string;
  features: string[];
  onUpgrade: () => void;
  loading?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className={`card p-4 ${highlight ? 'border-lava-500/30 bg-lava-500/5' : ''}`}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm font-bold text-text">{name}</p>
        {highlight && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-lava-500/20 text-lava-400 border border-lava-500/30">
            Most Popular
          </span>
        )}
      </div>
      <p className="text-lg font-bold text-lava-400 mb-3">{price}</p>
      <div className="space-y-1.5 mb-4">
        {features.map(f => (
          <div key={f} className="flex items-center gap-2">
            <CheckCircle2 size={11} className="text-green-400 flex-shrink-0" />
            <span className="text-xs text-text">{f}</span>
          </div>
        ))}
      </div>
      <button
        className="btn-primary w-full text-xs py-2"
        onClick={onUpgrade}
        disabled={loading}
      >
        {loading
          ? <><Loader2 size={13} className="animate-spin" /> Opening...</>
          : `Upgrade to ${name}`}
      </button>
    </div>
  );
}
