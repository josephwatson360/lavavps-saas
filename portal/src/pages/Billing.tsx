import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchAuthSession } from 'aws-amplify/auth';
import { CreditCard, HardDrive, Plus, CheckCircle2, Loader2, Settings, AlertCircle, RefreshCw } from 'lucide-react';
import { billingApi } from '@/api/client';
import { useStore, toast } from '@/store/useStore';
import api from '@/api/client';

// ─────────────────────────────────────────────────────────────────────────────
// Billing page
//
// Reads live billing state from GET /billing — source of truth is DynamoDB,
// NOT the JWT claim. This ensures plan, storage, and agent limits are always
// accurate regardless of when the JWT was last refreshed.
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_FEATURES: Record<string, string[]> = {
  starter:  ['2 agents', '5 GB storage', '0.25 vCPU / 1 GB RAM', 'Discord + Telegram', '15-min idle timeout'],
  pro:      ['4 agents', '50 GB storage', '0.5 vCPU / 1 GB RAM', 'Ralph Loop / Auto Tasks', 'Discord + Telegram + WhatsApp', '30-min idle timeout'],
  business: ['10 agents', '100 GB storage', '1 vCPU / 2 GB RAM', 'All Channel Integrations', 'Audit logs', '60-min idle timeout'],
};

const STORAGE_ADDONS = [
  { label: '+10 GB',  price: '$5',  gb: 10  },
  { label: '+50 GB',  price: '$25', gb: 50  },
  { label: '+100 GB', price: '$50', gb: 100 },
];

interface BillingInfo {
  planCode:           string;
  status:             string;
  subscriptionStatus: string;
  storageBase:        number;
  storageAddon:       number;
  storageTotal:       number;
  agentBase:          number;
  addonAgents:        number;
  agentMax:           number;
  stripeCustomerId:   string | null;
}

export function Billing() {
  const { agents }                        = useStore();
  const [searchParams, setSearchParams]   = useSearchParams();
  const [billingInfo, setBillingInfo]     = useState<BillingInfo | null>(null);
  const [loadingInfo, setLoadingInfo]     = useState(true);
  const [infoError, setInfoError]         = useState(false);
  const [loading, setLoading]             = useState<string | null>(null);
  const [checkoutStatus, setCheckoutStatus] = useState<'success' | 'cancelled' | null>(null);

  // Load live billing info from DynamoDB via API
  async function loadBillingInfo() {
    setLoadingInfo(true);
    setInfoError(false);
    try {
      const data = await api.get<BillingInfo>('/billing').then(r => r.data);
      setBillingInfo(data);
    } catch {
      setInfoError(true);
    } finally {
      setLoadingInfo(false);
    }
  }

  useEffect(() => {
    const status = searchParams.get('checkout');

    if (status) {
      setCheckoutStatus(status as 'success' | 'cancelled');
      setSearchParams({}, { replace: true });

      if (status === 'success') {
        // Force JWT refresh so Cognito-backed claims update, then reload billing
        fetchAuthSession({ forceRefresh: true })
          .catch(() => {})
          .finally(() => loadBillingInfo());
        return;
      }
    }

    loadBillingInfo();
  }, []);

  const plan        = billingInfo?.planCode ?? 'starter';
  const features    = PLAN_FEATURES[plan] ?? [];
  const agentMax    = billingInfo?.agentMax ?? 2;
  const usedAgents  = agents.length;
  const storageTotal = billingInfo?.storageTotal ?? 5;
  const storageAddon = billingInfo?.storageAddon ?? 0;

  async function handleCheckout(
    type: 'plan' | 'addon_agent' | 'addon_storage',
    extra?: { planCode?: string; storageGb?: number },
  ) {
    const key = `${type}_${extra?.planCode ?? extra?.storageGb ?? ''}`;
    setLoading(key);
    try {
      const { checkoutUrl } = await billingApi.createCheckout({
        type,
        planCode:  extra?.planCode,
        storageGb: extra?.storageGb,
      });
      window.location.href = checkoutUrl;
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? 'Failed to start checkout. Please try again.';
      toast.error(msg);
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

  function isLoading(key: string) { return loading === key; }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-text">Billing & Plan</h1>
          <p className="text-sm text-muted mt-1">Manage your subscription and add-ons</p>
        </div>
        <button
          className="btn-secondary text-xs flex items-center gap-1.5"
          onClick={loadBillingInfo}
          disabled={loadingInfo}
        >
          <RefreshCw size={12} className={loadingInfo ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Checkout status banners */}
      {checkoutStatus === 'success' && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-green-900/20 border border-green-700/30 mb-6">
          <CheckCircle2 size={16} className="text-green-400 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-green-300">Purchase successful!</p>
            <p className="text-xs text-green-400/70 mt-0.5">Your account limits have been updated below.</p>
          </div>
        </div>
      )}

      {checkoutStatus === 'cancelled' && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-obsidian-800 border border-border mb-6">
          <AlertCircle size={16} className="text-muted flex-shrink-0" />
          <p className="text-sm text-muted">Checkout was cancelled — no charge was made.</p>
        </div>
      )}

      {/* Error state */}
      {infoError && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-900/10 border border-red-900/30 mb-6">
          <AlertCircle size={16} className="text-red-400 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-red-300">Failed to load billing info.</p>
          </div>
          <button className="text-xs text-lava-400 hover:text-lava-300" onClick={loadBillingInfo}>
            Retry
          </button>
        </div>
      )}

      {/* Current plan */}
      <div className="card p-6 mb-6">
        {loadingInfo ? (
          <div className="flex items-center gap-3 py-4">
            <Loader2 size={16} className="animate-spin text-muted" />
            <span className="text-sm text-muted">Loading billing info...</span>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-xs text-muted uppercase tracking-wider mb-1">Current Plan</p>
                <div className="flex items-center gap-2">
                  <h2 className="font-display text-xl font-bold text-text capitalize">{plan}</h2>
                  {billingInfo?.subscriptionStatus === 'trialing' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/20 text-blue-400 border border-blue-700/30">
                      Trial
                    </span>
                  )}
                  {billingInfo?.status === 'SUSPENDED' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/20 text-red-400 border border-red-700/30">
                      Suspended
                    </span>
                  )}
                </div>
              </div>
              <button
                className="btn-secondary text-xs"
                onClick={handleManage}
                disabled={isLoading('portal') || !billingInfo?.stripeCustomerId}
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
                {(billingInfo?.addonAgents ?? 0) > 0 && (
                  <p className="text-xs text-muted mt-0.5">
                    {billingInfo!.agentBase} base + {billingInfo!.addonAgents} add-on
                  </p>
                )}
              </div>
              <div className="bg-obsidian-800 rounded-xl p-3">
                <p className="text-xs text-muted mb-1">Storage Pool</p>
                <p className="text-lg font-bold text-text">
                  {storageTotal} GB
                </p>
                {storageAddon > 0 && (
                  <p className="text-xs text-muted mt-0.5">
                    {billingInfo!.storageBase} GB base + {storageAddon} GB add-on
                  </p>
                )}
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

            <div className="mt-4 pt-4 border-t border-border">
              <p className="text-xs text-muted">
                To <strong className="text-text">downgrade</strong> your plan, update payment method, or view invoices, click{' '}
                <button onClick={handleManage} className="text-lava-400 hover:text-lava-300 underline transition-colors">
                  Manage Subscription
                </button>.
              </p>
            </div>
          </>
        )}
      </div>

      {/* Add-ons */}
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-text mb-3">Add-Ons</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

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

          <div className="card p-4">
            <div className="flex items-start gap-3 mb-3">
              <div className="w-8 h-8 rounded-lg bg-blue-900/20 flex items-center justify-center">
                <HardDrive size={14} className="text-blue-400" />
              </div>
              <div>
                <p className="text-sm font-medium text-text">Storage</p>
                <p className="text-xs text-muted">Added to your pool after purchase</p>
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
      {plan !== 'business' && !loadingInfo && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-text mb-3">Upgrade Plan</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {plan === 'starter' && (
              <PlanCard
                name="Pro"
                price="$79/mo"
                features={['4 agents', '50 GB storage', 'Ralph Loop / Auto Tasks', 'Discord + Telegram + WhatsApp', '30-min idle timeout']}
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
  name:      string;
  price:     string;
  features:  string[];
  onUpgrade: () => void;
  loading?:  boolean;
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
