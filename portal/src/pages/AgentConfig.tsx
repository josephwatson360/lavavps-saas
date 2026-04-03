import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Save, RefreshCw, Eye, EyeOff, ExternalLink, Loader2 } from 'lucide-react';
import { configApi, keysApi, modelsApi, channelsApi } from '@/api/client';
import { useStore, toast } from '@/store/useStore';
import type { AgentConfig as AgentConfigType, ProviderModel } from '@/api/types';

const TOKEN_LINKS: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/billing',
  openai:    'https://platform.openai.com/settings/billing',
  google:    'https://aistudio.google.com/apikey',
  xai:       'https://console.x.ai/billing',
  mistral:   'https://console.mistral.ai/billing',
  cohere:    'https://dashboard.cohere.com/billing',
};

export function AgentConfig() {
  const { agentId } = useParams<{ agentId: string }>();
  const { agents }  = useStore();
  const agent       = agents.find(a => a.agentId === agentId);

  const [config, setConfig]     = useState<AgentConfigType>({});
  const [models, setModels]     = useState<ProviderModel[]>([]);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [newApiKey, setNewApiKey] = useState('');
  const [showKey, setShowKey]   = useState(false);
  const [provider, setProvider] = useState('');

  useEffect(() => {
    if (!agentId) return;
    Promise.all([
      configApi.get(agentId),
      modelsApi.list(agentId),
    ]).then(([configRes, modelsRes]) => {
      setConfig(configRes.config);
      setModels(modelsRes.models);
      setProvider(modelsRes.provider ?? '');
    }).catch(() => toast.error('Failed to load config'))
      .finally(() => setLoading(false));
  }, [agentId]);

  async function handleSave() {
    if (!agentId) return;
    setSaving(true);
    try {
      // Remap model format if needed (provider/model)
      await configApi.update(agentId, config);
      toast.success('Config saved. Agent will hot-reload within seconds.');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } }).response?.data?.message;
      toast.error(msg ?? 'Failed to save config');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveApiKey() {
    if (!agentId || !newApiKey.trim() || !provider) return;
    setSaving(true);
    try {
      await keysApi.store(agentId, provider, newApiKey);
      setNewApiKey('');
      // Refresh models after key update
      const { models: m } = await modelsApi.list(agentId);
      setModels(m);
      toast.success('API key updated');
    } catch {
      toast.error('Failed to update API key');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="text-muted animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display text-2xl font-bold text-text">Configure Agent</h1>
          <p className="text-sm text-muted mt-1">{agent?.name || agentId}</p>
        </div>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <><Loader2 size={14} className="animate-spin" /> Saving...</> : <><Save size={14} /> Save</>}
        </button>
      </div>

      <div className="space-y-6">
        {/* System prompt */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-text mb-4">System Prompt</h2>
          <textarea
            className="input"
            rows={6}
            placeholder="You are a helpful assistant..."
            value={config.systemPrompt ?? ''}
            onChange={e => setConfig({ ...config, systemPrompt: e.target.value })}
            maxLength={8000}
          />
          <p className="text-xs text-muted mt-1.5 text-right">
            {(config.systemPrompt ?? '').length}/8000
          </p>
        </section>

        {/* LLM settings */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-text mb-4">LLM Settings</h2>
          <div className="space-y-4">
            {/* Model */}
            <div>
              <label className="label">Model</label>
              <select
                className="input"
                value={config.primaryModel ?? ''}
                onChange={e => setConfig({ ...config, primaryModel: e.target.value })}
              >
                <option value="">Select model...</option>
                {models.map(m => (
                  <option key={m.id} value={`${provider}/${m.id}`}>
                    {m.id}{m.isDefault ? ' (recommended)' : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Temperature + Max tokens side by side */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Temperature ({config.temperature ?? 0.7})</label>
                <input
                  type="range"
                  min={0} max={1} step={0.05}
                  value={config.temperature ?? 0.7}
                  onChange={e => setConfig({ ...config, temperature: parseFloat(e.target.value) })}
                  className="w-full accent-lava-500"
                />
                <div className="flex justify-between text-[10px] text-muted mt-0.5">
                  <span>Precise</span><span>Creative</span>
                </div>
              </div>
              <div>
                <label className="label">Max Tokens</label>
                <input
                  type="number"
                  className="input"
                  min={256}
                  value={config.maxTokens ?? 4096}
                  onChange={e => setConfig({ ...config, maxTokens: parseInt(e.target.value) })}
                />
              </div>
            </div>

            {/* Token purchase link */}
            {provider && TOKEN_LINKS[provider] && (
              <a
                href={TOKEN_LINKS[provider]}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-lava-400 hover:text-lava-300 transition-colors"
              >
                <ExternalLink size={11} />
                Purchase {provider} tokens
              </a>
            )}
          </div>
        </section>

        {/* API Key rotation */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-text mb-1">API Key</h2>
          <p className="text-xs text-muted mb-4">
            Your current API key is active. Enter a new key below to rotate it.
          </p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showKey ? 'text' : 'password'}
                className="input pr-9"
                placeholder="Enter new API key to rotate..."
                value={newApiKey}
                onChange={e => setNewApiKey(e.target.value)}
              />
              <button
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-text"
                onClick={() => setShowKey(!showKey)}
                type="button"
              >
                {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <button
              className="btn-secondary"
              onClick={handleSaveApiKey}
              disabled={!newApiKey.trim() || saving}
            >
              <RefreshCw size={13} />
              Rotate
            </button>
          </div>
        </section>

        {/* Session settings */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-text mb-4">Session Behavior</h2>
          <div className="space-y-4">
            <div>
              <label className="label">Agent Name</label>
              <input
                className="input"
                placeholder="My assistant"
                value={config.agentName ?? ''}
                onChange={e => setConfig({ ...config, agentName: e.target.value })}
                maxLength={64}
              />
            </div>
            <div>
              <label className="label">Session Reset</label>
              <select
                className="input"
                value={config.sessionResetMode ?? 'never'}
                onChange={e => setConfig({ ...config, sessionResetMode: e.target.value as 'daily' | 'idle' | 'never' })}
              >
                <option value="never">Keep full history</option>
                <option value="daily">Fresh start daily</option>
                <option value="idle">Reset after inactivity</option>
              </select>
            </div>
            {config.sessionResetMode === 'idle' && (
              <div>
                <label className="label">Idle Timeout (minutes)</label>
                <input
                  type="number"
                  className="input"
                  min={30} max={480}
                  value={config.sessionIdleMinutes ?? 60}
                  onChange={e => setConfig({ ...config, sessionIdleMinutes: parseInt(e.target.value) })}
                />
              </div>
            )}
          </div>
        </section>

        {/* Channel integrations */}
        <ChannelConfig agentId={agentId!} planCode={useStore.getState().tenant?.planCode ?? 'starter'} />

        {/* Save footer */}
        <div className="flex justify-end pt-2">
          <button className="btn-primary px-6" onClick={handleSave} disabled={saving}>
            {saving ? <><Loader2 size={14} className="animate-spin" /> Saving...</> : <><Save size={14} /> Save All Changes</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChannelConfig({ agentId, planCode }: { agentId: string; planCode: string }) {
  const [discord, setDiscord]   = useState({ botToken: '', guildId: '' });
  const [telegram, setTelegram] = useState({ botToken: '' });
  const [saving, setSaving]     = useState(false);
  const isProPlus = planCode === 'pro' || planCode === 'business';

  async function saveChannels() {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      if (discord.botToken)  payload.discord  = { botToken: discord.botToken, guildId: discord.guildId };
      if (telegram.botToken) payload.telegram = { botToken: telegram.botToken };

      if (Object.keys(payload).length > 0) {
        await channelsApi.update(agentId, payload as Parameters<typeof channelsApi.update>[1]);
        toast.success('Channel integrations saved');
      }
    } catch {
      toast.error('Failed to save channels');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-text mb-4">Channel Integrations</h2>
      <div className="space-y-5">
        {/* Discord */}
        <div>
          <label className="label flex items-center gap-1.5">
            <span>🎮</span> Discord
          </label>
          <div className="space-y-2">
            <input
              type="password"
              className="input"
              placeholder="Bot token"
              value={discord.botToken}
              onChange={e => setDiscord({ ...discord, botToken: e.target.value })}
            />
            <input
              className="input"
              placeholder="Guild ID (optional)"
              value={discord.guildId}
              onChange={e => setDiscord({ ...discord, guildId: e.target.value })}
            />
          </div>
        </div>

        {/* Telegram */}
        <div>
          <label className="label flex items-center gap-1.5">
            <span>✈️</span> Telegram
          </label>
          <input
            type="password"
            className="input"
            placeholder="Bot token from @BotFather"
            value={telegram.botToken}
            onChange={e => setTelegram({ ...telegram, botToken: e.target.value })}
          />
        </div>

        {/* WhatsApp - Pro+ */}
        {!isProPlus && (
          <div className="p-3 rounded-lg border border-border/50 bg-obsidian-800/50 opacity-60">
            <p className="text-xs text-muted flex items-center gap-2">
              <span>💬</span>
              WhatsApp integration requires Pro plan or higher.
            </p>
          </div>
        )}

        <button
          className="btn-secondary w-full"
          onClick={saveChannels}
          disabled={saving}
        >
          {saving ? <><Loader2 size={13} className="animate-spin" /> Saving...</> : 'Save Integrations'}
        </button>
      </div>
    </section>
  );
}
