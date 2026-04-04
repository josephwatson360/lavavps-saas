import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronRight, Eye, EyeOff, Loader2, Bot, Zap } from 'lucide-react';
import { clsx }            from 'clsx';
import { agentsApi, keysApi, modelsApi } from '@/api/client';
import { useStore, toast }  from '@/store/useStore';
import type { ProviderModel } from '@/api/types';

const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic',  logo: '🟠', desc: 'Claude models',        placeholder: 'sk-ant-...' },
  { id: 'openai',    name: 'OpenAI',     logo: '🟢', desc: 'GPT models',           placeholder: 'sk-...' },
  { id: 'google',    name: 'Google',     logo: '🔵', desc: 'Gemini models',        placeholder: 'AIza...' },
  { id: 'xai',       name: 'xAI',        logo: '🟣', desc: 'Grok models',          placeholder: 'xai-...' },
  { id: 'mistral',   name: 'Mistral',    logo: '🟡', desc: 'Mistral models',       placeholder: 'key...' },
  { id: 'cohere',    name: 'Cohere',     logo: '🩵', desc: 'Command models',       placeholder: 'key...' },
];

export function NewAgentWizard() {
  const navigate   = useNavigate();
  const { updateAgent } = useStore();

  const [step, setStep]             = useState(1);
  const [agentName, setAgentName]   = useState('');
  const [provider, setProvider]     = useState('');
  const [apiKey, setApiKey]         = useState('');
  const [showKey, setShowKey]       = useState(false);
  const [model, setModel]           = useState('');
  const [models, setModels]         = useState<ProviderModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [agentId, setAgentId]       = useState('');
  const [provisioning, setProvisioning]   = useState(false);
  const [provisionStep, setProvisionStep] = useState('');

  // Step 1: Provider selection
  async function handleProviderSelect(p: string) {
    if (!agentName.trim()) {
      toast.error('Please give your agent a name first');
      return;
    }
    setProvider(p);
    setStep(2);
  }

  // Step 2: API key entry → fetch models
  async function handleKeySubmit() {
    if (!apiKey.trim()) { toast.error('Enter your API key'); return; }
    setLoadingModels(true);

    // Create agent first so we can call modelsHandler with the key
    try {
      const { agentId: id } = await agentsApi.create(agentName || undefined);
      setAgentId(id);

      await keysApi.store(id, provider, apiKey);

      const { models: list, defaultModel } = await modelsApi.list(id);
      setModels(list);
      setModel(defaultModel ?? list[0]?.id ?? '');
      setStep(3);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      toast.error(msg ?? 'Failed to validate key. Check that it is correct.');
    } finally {
      setLoadingModels(false);
    }
  }

  // Step 3: Model selection
  function handleModelSelect(modelId: string) {
    setModel(modelId);
    setStep(4);
    startProvisioning(modelId);
  }

  // Step 4: Provisioning
  async function startProvisioning(selectedModel: string) {
    setProvisioning(true);
    const steps = [
      'Setting up agent record...',
      'Configuring LLM provider...',
      'Creating workspace storage...',
      'Rendering initial config...',
      'Agent is almost ready...',
    ];
    let i = 0;
    const interval = setInterval(() => {
      setProvisionStep(steps[i % steps.length]);
      i++;
    }, 2000);

    try {
      // Set primary model on config
      const { configApi } = await import('@/api/client');
      await configApi.update(agentId, {
        primaryModel: `${provider}/${selectedModel}`,
        agentName: agentName || undefined,
      });

      clearInterval(interval);
      setProvisionStep('Agent ready! 🎉');

      // Update store
      const agent = await agentsApi.get(agentId);
      useStore.getState().setAgents([
        ...useStore.getState().agents,
        agent,
      ]);

      setTimeout(() => {
        navigate(`/chat/${agentId}`);
      }, 1200);
    } catch {
      clearInterval(interval);
      toast.error('Provisioning error. Your agent was created — configure it from the dashboard.');
      navigate('/dashboard');
    }
  }

  const providerInfo = PROVIDERS.find(p => p.id === provider);

  return (
    <div className="max-w-xl mx-auto px-6 py-10">
      {/* Header */}
      <div className="mb-8">
        <h1 className="font-display text-2xl font-bold text-text">New Agent</h1>
        <p className="text-sm text-muted mt-1">Set up your AI agent in 3 steps</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {['Provider', 'API Key', 'Model', 'Ready'].map((label, i) => {
          const n = i + 1;
          const done    = step > n;
          const current = step === n;
          return (
            <div key={label} className="flex items-center gap-2">
              <div className={clsx(
                'w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold',
                done    ? 'bg-green-500 text-white' :
                current ? 'bg-lava-500 text-white' :
                          'bg-obsidian-700 text-muted',
              )}>
                {done ? <Check size={12} /> : n}
              </div>
              <span className={clsx(
                'text-xs hidden sm:block',
                current ? 'text-text' : 'text-muted',
              )}>{label}</span>
              {i < 3 && <ChevronRight size={12} className="text-muted/40" />}
            </div>
          );
        })}
      </div>

      {/* Step 1: Provider */}
      {step === 1 && (
        <div className="space-y-4 animate-fade-in">
          <div className="mb-2">
            <label className="label">Agent name (optional)</label>
            <input
              className="input"
              placeholder="My assistant"
              value={agentName}
              onChange={e => setAgentName(e.target.value)}
              maxLength={64}
            />
          </div>

          <div>
            <label className="label">LLM Provider</label>
            <div className="grid grid-cols-2 gap-3">
              {PROVIDERS.map(p => (
                <button
                  key={p.id}
                  className={clsx(
                    'card-hover p-4 text-left transition-all',
                    provider === p.id && 'border-lava-500/40 bg-lava-500/5',
                  )}
                  onClick={() => handleProviderSelect(p.id)}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg">{p.logo}</span>
                    <span className="text-sm font-semibold text-text">{p.name}</span>
                  </div>
                  <p className="text-xs text-muted">{p.desc}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Step 2: API Key */}
      {step === 2 && providerInfo && (
        <div className="space-y-5 animate-fade-in">
          <div className="flex items-center gap-3 p-4 rounded-xl bg-obsidian-800 border border-border">
            <span className="text-2xl">{providerInfo.logo}</span>
            <div>
              <p className="text-sm font-semibold text-text">{providerInfo.name}</p>
              <a
                href={`https://console.anthropic.com/settings/keys`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-lava-400 hover:text-lava-300 transition-colors"
              >
                Get your API key ↗
              </a>
            </div>
          </div>

          <div>
            <label className="label">{providerInfo.name} API Key</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                className="input pr-10"
                placeholder={providerInfo.placeholder}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleKeySubmit()}
                autoFocus
              />
              <button
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text"
                onClick={() => setShowKey(!showKey)}
                type="button"
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <p className="text-xs text-muted mt-1.5">
              Stored encrypted in AWS Secrets Manager. Never logged or returned after this step.
            </p>
          </div>

          <div className="flex gap-3">
            <button className="btn-secondary flex-1" onClick={() => setStep(1)}>
              Back
            </button>
            <button
              className="btn-primary flex-1"
              onClick={handleKeySubmit}
              disabled={!apiKey.trim() || loadingModels}
            >
              {loadingModels ? <><Loader2 size={14} className="animate-spin" /> Validating...</> : 'Continue'}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Model selection */}
      {step === 3 && (
        <div className="space-y-4 animate-fade-in">
          <p className="text-sm text-muted">
            Choose a model. The default is pre-selected as the most cost-effective option.
          </p>

          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {models.map(m => (
              <button
                key={m.id}
                className={clsx(
                  'w-full flex items-center justify-between p-3.5 rounded-xl border text-left transition-all',
                  model === m.id
                    ? 'border-lava-500/40 bg-lava-500/5 text-text'
                    : 'border-border bg-obsidian-800 text-muted hover:border-obsidian-500 hover:text-text',
                )}
                onClick={() => handleModelSelect(m.id)}
              >
                <div className="flex items-center gap-2.5">
                  <Zap size={13} className={model === m.id ? 'text-lava-400' : 'text-muted'} />
                  <span className="font-mono text-xs">{m.id}</span>
                </div>
                <div className="flex items-center gap-2">
                  {m.isDefault && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-lava-500/10 text-lava-400 border border-lava-500/20">
                      Recommended
                    </span>
                  )}
                  {model === m.id && <Check size={14} className="text-lava-400" />}
                </div>
              </button>
            ))}
          </div>

          <button className="btn-secondary w-full" onClick={() => setStep(2)}>
            Back
          </button>
        </div>
      )}

      {/* Step 4: Provisioning */}
      {step === 4 && (
        <div className="flex flex-col items-center py-12 text-center animate-fade-in">
          <div className={clsx(
            'w-16 h-16 rounded-2xl flex items-center justify-center mb-5',
            provisioning
              ? 'bg-lava-500/10 border border-lava-500/30 animate-pulse-lava'
              : 'bg-green-900/20 border border-green-900/30',
          )}>
            {provisioning
              ? <Loader2 size={28} className="text-lava-400 animate-spin" />
              : <Bot size={28} className="text-green-400" />}
          </div>
          <h2 className="text-lg font-bold text-text mb-2">
            {provisioning ? 'Provisioning agent...' : 'Agent ready!'}
          </h2>
          <p className="text-sm text-muted animate-pulse">{provisionStep}</p>
          {!provisioning && (
            <p className="text-sm text-green-400 mt-2">Redirecting to chat...</p>
          )}
        </div>
      )}
    </div>
  );
}
