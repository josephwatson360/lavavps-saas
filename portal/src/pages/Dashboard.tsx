import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, RefreshCw, Bot, TrendingUp } from 'lucide-react';
import { AgentCard }   from '@/components/AgentCard';
import { agentsApi }   from '@/api/client';
import api             from '@/api/client';
import { useStore, toast } from '@/store/useStore';

export function Dashboard() {
  const navigate  = useNavigate();
  const { agents, setAgents } = useStore();
  const [loading, setLoading]  = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [agentMax, setAgentMax] = useState(2);

  async function load(quiet = false) {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    try {
      const [{ agents: list }, billingRes] = await Promise.all([
        agentsApi.list(),
        api.get<{ agentMax: number }>('/billing').catch(() => ({ data: { agentMax: 2 } })),
      ]);
      setAgents(list);
      setAgentMax(billingRes.data.agentMax ?? 2);
    } catch {
      toast.error('Failed to load agents');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const running  = agents.filter(a => a.status === 'RUNNING').length;
  const canAdd   = agents.length < agentMax;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display text-2xl font-bold text-text">Agents</h1>
          <p className="text-sm text-muted mt-1">
            {agents.length}/{agentMax} agents ·{' '}
            <span className="text-green-400">{running} running</span>
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            className="btn-secondary"
            onClick={() => load(true)}
            disabled={refreshing}
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            className="btn-primary"
            onClick={() => navigate('/new-agent')}
            disabled={!canAdd}
            title={!canAdd ? `Plan limit reached (${agentMax} agents). Add an agent add-on to continue.` : undefined}
          >
            <Plus size={14} />
            New Agent
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        {[
          { label: 'Total Agents',   value: agents.length,  max: agentMax,  unit: `/ ${agentMax}` },
          { label: 'Active Now',     value: running,        unit: 'running' },
          { label: 'Plan',           value: tenant?.planCode ?? '—', unit: '' },
        ].map(({ label, value, unit }) => (
          <div key={label} className="card px-5 py-4">
            <p className="text-xs text-muted uppercase tracking-wider mb-1">{label}</p>
            <p className="text-xl font-bold text-text">
              {value}
              <span className="text-sm font-normal text-muted ml-1.5 capitalize">{unit}</span>
            </p>
          </div>
        ))}
      </div>

      {/* Agent grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="card p-5 h-36 animate-pulse bg-obsidian-800" />
          ))}
        </div>
      ) : agents.length === 0 ? (
        <EmptyState onAdd={() => navigate('/new-agent')} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map(agent => (
            <AgentCard key={agent.agentId} agent={agent} />
          ))}

          {/* Add agent card */}
          {canAdd && (
            <button
              className="card border-dashed border-border/50 flex flex-col items-center justify-center gap-2 h-36 text-muted hover:text-lava-400 hover:border-lava-500/30 transition-all"
              onClick={() => navigate('/new-agent')}
            >
              <Plus size={20} />
              <span className="text-sm">New Agent</span>
            </button>
          )}
        </div>
      )}

      {/* Add-on upsell */}
      {!canAdd && (
        <div className="mt-6 p-4 rounded-xl border border-lava-500/20 bg-lava-500/5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <TrendingUp size={16} className="text-lava-400" />
            <p className="text-sm text-text">
              You've reached your {tenant?.planCode} plan limit ({agentMax} agents).
            </p>
          </div>
          <button
            className="btn-primary text-xs px-3 py-1.5"
            onClick={() => navigate('/billing')}
          >
            Add Agent — $15.99/mo
          </button>
        </div>
      )}
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-16 h-16 rounded-2xl bg-obsidian-800 border border-border flex items-center justify-center mb-5">
        <Bot size={28} className="text-muted" />
      </div>
      <h2 className="text-lg font-semibold text-text mb-2">No agents yet</h2>
      <p className="text-sm text-muted max-w-xs mb-6">
        Create your first agent. Connect your LLM provider API key and start chatting in under 2 minutes.
      </p>
      <button className="btn-primary" onClick={onAdd}>
        <Plus size={14} />
        Create your first agent
      </button>
    </div>
  );
}
