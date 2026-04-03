import {
  useState, useEffect, useRef, useCallback, KeyboardEvent,
} from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Send, RefreshCw, Square, ChevronDown, Bot, AlertCircle,
  Wifi, WifiOff, Loader2, Zap,
} from 'lucide-react';
import { clsx }              from 'clsx';
import { useAgentChat }      from '@/hooks/useAgentChat';
import { useStore }          from '@/store/useStore';
import { agentsApi }         from '@/api/client';
import { formatDistanceToNow } from 'date-fns';
import type { ChatMessage }  from '@/api/types';

// ─────────────────────────────────────────────────────────────────────────────
// Chat page — the most critical screen in the portal.
//
// CRITICAL REQUIREMENTS:
//  1. Input auto-focuses on load and after EVERY agent response.
//     User must NEVER have to click the input box to type again.
//  2. Pre-wake: if agent is STOPPED, show spinner while task starts.
//  3. Streaming: partial responses show progressively.
// ─────────────────────────────────────────────────────────────────────────────

export function Chat() {
  const { agentId: paramId } = useParams<{ agentId: string }>();
  const navigate    = useNavigate();
  const { agents }  = useStore();
  const scrollRef   = useRef<HTMLDivElement>(null);

  // Resolve active agent — use URL param or first running/stopped agent
  const agentId = paramId ?? agents[0]?.agentId;
  const agent   = agents.find(a => a.agentId === agentId);

  const {
    wsState, isTyping, error, inputRef,
    sendMessage, connect, disconnect,
  } = useAgentChat({ agentId: agentId ?? '' });

  const messages = useStore(s => s.messages[agentId ?? ''] ?? []);
  const [input, setInput]       = useState('');
  const [atBottom, setAtBottom] = useState(true);

  // ── Auto-scroll to bottom on new messages ────────────────────────────────
  useEffect(() => {
    if (atBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping, atBottom]);

  // Track scroll position
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  }

  // ── Send message ─────────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || wsState !== 'connected') return;
    sendMessage(text);
    setInput('');
    // inputRef focus is handled by useAgentChat after response
  }, [input, wsState, sendMessage]);

  // ── Keyboard shortcut: Enter to send, Shift+Enter for newline ────────────
  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (!agentId) {
    return (
      <div className="flex-1 flex items-center justify-center flex-col gap-4 p-8 text-center">
        <Bot size={32} className="text-muted" />
        <p className="text-muted">No agents found.</p>
        <button className="btn-primary" onClick={() => navigate('/new-agent')}>
          Create an Agent
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-border bg-obsidian-900/50">
        <div className="flex items-center gap-3">
          <div className={clsx(
            'w-8 h-8 rounded-xl flex items-center justify-center',
            wsState === 'connected' ? 'bg-green-900/20' : 'bg-obsidian-700',
          )}>
            <Bot size={16} className={wsState === 'connected' ? 'text-green-400' : 'text-muted'} />
          </div>
          <div>
            <p className="text-sm font-semibold text-text">
              {agent?.name || agentId.slice(0, 8)}
            </p>
            <p className="text-xs text-muted flex items-center gap-1.5">
              <WsStatusIndicator state={wsState} />
            </p>
          </div>
        </div>

        {/* Agent selector if multiple agents */}
        {agents.length > 1 && (
          <select
            className="bg-obsidian-800 border border-border rounded-lg px-2 py-1 text-xs text-text"
            value={agentId}
            onChange={e => navigate(`/chat/${e.target.value}`)}
          >
            {agents.map(a => (
              <option key={a.agentId} value={a.agentId}>
                {a.name || a.agentId.slice(0, 8)}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Pre-wake state */}
      {(wsState === 'waking' || wsState === 'connecting') && (
        <div className="mx-5 mt-4 p-4 rounded-xl border border-blue-900/30 bg-blue-900/10 flex items-center gap-3">
          <Loader2 size={16} className="text-blue-400 animate-spin flex-shrink-0" />
          <div>
            <p className="text-sm text-blue-300 font-medium">
              {wsState === 'waking' ? 'Starting your agent...' : 'Connecting...'}
            </p>
            <p className="text-xs text-muted mt-0.5">
              {wsState === 'waking' ? 'Cold start takes ~15–30 seconds' : 'Establishing connection'}
            </p>
          </div>
        </div>
      )}

      {/* Error state */}
      {(wsState === 'error' || wsState === 'disconnected') && (
        <div className="mx-5 mt-4 p-4 rounded-xl border border-red-900/30 bg-red-900/10 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <AlertCircle size={16} className="text-red-400 flex-shrink-0" />
            <p className="text-sm text-red-300">{error ?? 'Connection lost'}</p>
          </div>
          <button className="btn-secondary text-xs px-3 py-1.5" onClick={connect}>
            <RefreshCw size={12} />
            Reconnect
          </button>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 py-4 space-y-4"
        onScroll={handleScroll}
      >
        {messages.length === 0 && wsState === 'connected' && (
          <WelcomeMessage agentName={agent?.name} />
        )}

        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Typing indicator */}
        {isTyping && (
          <div className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-xl bg-obsidian-700 flex items-center justify-center flex-shrink-0">
              <Bot size={13} className="text-muted" />
            </div>
            <div className="msg-agent">
              <div className="typing-dots flex items-center gap-1 py-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-muted" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted" />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Scroll to bottom button */}
      {!atBottom && (
        <button
          className="absolute right-6 bottom-24 w-8 h-8 rounded-full bg-obsidian-700 border border-border flex items-center justify-center shadow-card hover:bg-obsidian-600 transition-colors"
          onClick={() => {
            if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }}
        >
          <ChevronDown size={14} className="text-muted" />
        </button>
      )}

      {/* Input area — CRITICAL: auto-focus at all times */}
      <div className="px-5 pb-5 pt-3 border-t border-border bg-obsidian-900/30">
        <div className={clsx(
          'flex items-end gap-2 bg-obsidian-800 border rounded-xl px-3 py-2.5 transition-all',
          wsState === 'connected'
            ? 'border-border focus-within:border-lava-500/50'
            : 'border-border opacity-60',
        )}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              wsState === 'connected' ? 'Message your agent...' :
              wsState === 'waking'    ? 'Agent is starting...' :
              wsState === 'error'     ? 'Reconnect to continue' :
                                        'Connecting...'
            }
            disabled={wsState !== 'connected'}
            rows={1}
            className="flex-1 bg-transparent text-sm text-text placeholder:text-muted
                       resize-none max-h-32 focus:outline-none leading-relaxed
                       disabled:cursor-not-allowed"
            style={{ minHeight: '24px' }}
            // Auto-resize textarea
            onInput={e => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
            }}
          />
          <button
            className={clsx(
              'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-all',
              input.trim() && wsState === 'connected'
                ? 'bg-lava-500 text-white hover:bg-lava-400'
                : 'bg-obsidian-700 text-muted cursor-not-allowed',
            )}
            onClick={handleSend}
            disabled={!input.trim() || wsState !== 'connected'}
          >
            <Send size={14} />
          </button>
        </div>
        <p className="text-[10px] text-muted mt-1.5 text-center">
          Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function WsStatusIndicator({ state }: { state: string }) {
  if (state === 'connected')    return <><Wifi size={10} className="text-green-400" /> Connected</>;
  if (state === 'waking')       return <><Loader2 size={10} className="text-blue-400 animate-spin" /> Starting agent...</>;
  if (state === 'connecting')   return <><Loader2 size={10} className="text-blue-400 animate-spin" /> Connecting...</>;
  if (state === 'disconnected') return <><WifiOff size={10} className="text-red-400" /> Disconnected</>;
  if (state === 'error')        return <><WifiOff size={10} className="text-red-400" /> Connection error</>;
  return <><Loader2 size={10} className="text-muted animate-spin" /> Initializing...</>;
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={clsx(
      'flex items-start gap-3 animate-slide-up',
      isUser && 'flex-row-reverse',
    )}>
      {/* Avatar */}
      <div className={clsx(
        'w-7 h-7 rounded-xl flex items-center justify-center flex-shrink-0',
        isUser ? 'bg-lava-500/20' : 'bg-obsidian-700',
      )}>
        {isUser
          ? <span className="text-xs text-lava-400 font-bold">Y</span>
          : <Bot size={13} className="text-muted" />}
      </div>

      {/* Bubble */}
      <div className={clsx(
        'max-w-[72%]',
        isUser ? 'items-end' : 'items-start',
        'flex flex-col gap-1',
      )}>
        <div className={isUser ? 'msg-user' : 'msg-agent'}>
          <p className="text-sm text-text leading-relaxed whitespace-pre-wrap">
            {message.content}
            {message.streaming && (
              <span className="inline-block w-0.5 h-4 bg-lava-400 ml-0.5 animate-pulse align-middle" />
            )}
          </p>
        </div>
        <span className="text-[10px] text-muted px-1">
          {formatDistanceToNow(new Date(message.timestamp), { addSuffix: true })}
        </span>
      </div>
    </div>
  );
}

function WelcomeMessage({ agentName }: { agentName?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="w-14 h-14 rounded-2xl bg-lava-500/10 border border-lava-500/20 flex items-center justify-center mb-4">
        <Zap size={24} className="text-lava-400" />
      </div>
      <h3 className="text-base font-semibold text-text mb-1">
        {agentName ? `${agentName} is ready` : 'Agent is ready'}
      </h3>
      <p className="text-sm text-muted max-w-xs">
        Start typing to begin your conversation. Your agent's memory persists between sessions.
      </p>
    </div>
  );
}
