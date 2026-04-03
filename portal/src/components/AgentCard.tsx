import { useNavigate }  from 'react-router-dom';
import { MessageSquare, Settings, Play, Square, Trash2, Bot, Zap } from 'lucide-react';
import { clsx }          from 'clsx';
import { StatusBadge }   from './StatusBadge';
import { agentsApi }     from '@/api/client';
import { useStore, toast } from '@/store/useStore';
import type { Agent }    from '@/api/types';
import { formatDistanceToNow } from 'date-fns';

interface AgentCardProps {
  agent: Agent;
}

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: 'text-orange-400',
  openai:    'text-green-400',
  google:    'text-blue-400',
  xai:       'text-purple-400',
  mistral:   'text-yellow-400',
  cohere:    'text-teal-400',
};

function getProviderFromModel(model: string | null): string {
  if (!model) return '';
  if (model.includes('claude'))  return 'anthropic';
  if (model.includes('gpt') || model.includes('o1') || model.includes('o3')) return 'openai';
  if (model.includes('gemini'))  return 'google';
  if (model.includes('grok'))    return 'xai';
  if (model.includes('mistral')) return 'mistral';
  return '';
}

export function AgentCard({ agent }: AgentCardProps) {
  const navigate   = useNavigate();
  const updateAgent = useStore(s => s.updateAgent);
  const provider   = getProviderFromModel(agent.primaryModel);
  const isActive   = agent.status === 'RUNNING' || agent.status === 'STARTING';

  async function handleStart(e: React.MouseEvent) {
    e.stopPropagation();
    updateAgent(agent.agentId, { status: 'STARTING' });
    try {
      const res = await agentsApi.start(agent.agentId);
      updateAgent(agent.agentId, { status: res.status });
    } catch {
      toast.error('Failed to start agent');
      updateAgent(agent.agentId, { status: 'STOPPED' });
    }
  }

  async function handleStop(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await agentsApi.stop(agent.agentId);
      updateAgent(agent.agentId, { status: 'STOPPED', taskArn: null });
    } catch {
      toast.error('Failed to stop agent');
    }
  }

  const lastActivity = agent.lastActivityAt
    ? formatDistanceToNow(new Date(agent.lastActivityAt), { addSuffix: true })
    : null;

  return (
    <div
      className={clsx(
        'card-hover p-5 cursor-pointer group',
        'flex flex-col gap-4',
        agent.status === 'RUNNING' && 'border-green-900/30',
        agent.status === 'SUSPENDED' && 'border-red-900/30 opacity-75',
      )}
      onClick={() => navigate(`/chat/${agent.agentId}`)}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className={clsx(
            'w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0',
            agent.status === 'RUNNING' ? 'bg-green-900/20 text-green-400' : 'bg-obsidian-700 text-muted',
          )}>
            <Bot size={18} />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-text text-sm truncate">
              {agent.name || agent.agentId.slice(0, 8)}
            </h3>
            <div className="flex items-center gap-1.5 mt-0.5">
              <StatusBadge status={agent.status} size="sm" />
            </div>
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {!isActive ? (
            <button
              onClick={handleStart}
              className="btn-icon btn-ghost text-green-400 hover:bg-green-900/20"
              title="Start agent"
            >
              <Play size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={handleStop}
              className="btn-icon btn-ghost text-red-400 hover:bg-red-900/20"
              title="Stop agent"
            >
              <Square size={14} fill="currentColor" />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/config/${agent.agentId}`); }}
            className="btn-icon btn-ghost"
            title="Configure"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      {/* Model */}
      <div className="flex items-center gap-2">
        {agent.primaryModel ? (
          <>
            <Zap size={12} className={PROVIDER_COLORS[provider] || 'text-muted'} />
            <span className="font-mono text-xs text-muted truncate">
              {agent.primaryModel}
            </span>
          </>
        ) : (
          <span className="text-xs text-muted italic">No LLM configured</span>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-3 border-t border-border">
        <div className="text-xs text-muted">
          {lastActivity ? `Active ${lastActivity}` : 'Never active'}
        </div>
        <button
          className="flex items-center gap-1.5 text-xs text-muted hover:text-lava-400 transition-colors"
          onClick={(e) => { e.stopPropagation(); navigate(`/chat/${agent.agentId}`); }}
        >
          <MessageSquare size={12} />
          Chat
        </button>
      </div>
    </div>
  );
}
