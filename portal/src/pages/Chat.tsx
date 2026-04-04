import {
  useState, useEffect, useRef, useCallback, KeyboardEvent,
} from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Send, RefreshCw, Square, ChevronDown, Bot, AlertCircle,
  Wifi, WifiOff, Loader2, Zap, Paperclip, X, ChevronUp,
  Check,
} from 'lucide-react';
import { clsx }              from 'clsx';
import { useAgentChat }      from '@/hooks/useAgentChat';
import { useStore }          from '@/store/useStore';
import { filesApi, modelsApi, configApi } from '@/api/client';
import { formatDistanceToNow } from 'date-fns';
import type { ChatMessage, ChatAttachment, ProviderModel } from '@/api/types';

// ─────────────────────────────────────────────────────────────────────────────
// Chat page
//
// CRITICAL REQUIREMENTS:
//  1. Input auto-focuses on load and after EVERY agent response.
//     User must NEVER have to click the input box to type again.
//  2. Pre-wake: if agent is STOPPED, show spinner while task starts.
//  3. Streaming: partial responses show word-by-word.
//  4. File upload: attach files from EFS workspace before sending.
//  5. LLM switcher: change model mid-conversation from input bar.
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: 'text-orange-400',
  openai:    'text-green-400',
  google:    'text-blue-400',
  xai:       'text-purple-400',
  mistral:   'text-yellow-400',
  cohere:    'text-teal-400',
};

export function Chat() {
  const { agentId: paramId } = useParams<{ agentId: string }>();
  const navigate    = useNavigate();
  const { agents }  = useStore();
  const scrollRef   = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const agentId = paramId ?? agents[0]?.agentId;
  const agent   = agents.find(a => a.agentId === agentId);

  const {
    wsState, isTyping, error, inputRef,
    sendMessage, connect,
  } = useAgentChat({ agentId: agentId ?? '' });

  const messages = useStore(s => s.messages[agentId ?? ''] ?? []);
  const [input, setInput]               = useState('');
  const [atBottom, setAtBottom]         = useState(true);
  const [attachments, setAttachments]   = useState<ChatAttachment[]>([]);
  const [uploading, setUploading]       = useState(false);
  const [showModels, setShowModels]     = useState(false);
  const [models, setModels]             = useState<ProviderModel[]>([]);
  const [currentModel, setCurrentModel] = useState<string>(agent?.primaryModel ?? '');
  const [switchingModel, setSwitchingModel] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll
  useEffect(() => {
    if (atBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping, atBottom]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  }

  // Load models for LLM switcher
  useEffect(() => {
    if (!agentId) return;
    modelsApi.list(agentId)
      .then(r => {
        setModels(r.models);
        setCurrentModel(agent?.primaryModel ?? '');
      })
      .catch(() => {});
  }, [agentId]); // eslint-disable-line

  // Close model picker on outside click
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModels(false);
      }
    }
    if (showModels) document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showModels]);

  // ── Send ───────────────────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || wsState !== 'connected') return;
    sendMessage(text, attachments.length > 0 ? attachments : undefined);
    setInput('');
    setAttachments([]);
  }, [input, attachments, wsState, sendMessage]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // ── File upload ────────────────────────────────────────────────────────────
  async function handleFileSelect(files: FileList | null) {
    if (!files || !agentId) return;
    setUploading(true);
    const uploaded: ChatAttachment[] = [];
    for (const file of Array.from(files)) {
      try {
        const { uploadUrl, key } = await filesApi.getUploadUrl(
          agentId, file.name, file.size, file.type,
        );
        await filesApi.uploadToS3(uploadUrl, file);
        uploaded.push({ key, name: file.name, size: file.size, contentType: file.type });
      } catch { /* skip failed uploads */ }
    }
    setAttachments(prev => [...prev, ...uploaded]);
    setUploading(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function removeAttachment(key: string) {
    setAttachments(prev => prev.filter(a => a.key !== key));
  }

  // ── Model switcher ─────────────────────────────────────────────────────────
  async function handleModelSwitch(modelId: string) {
    if (!agentId) return;
    const provider = currentModel.split('/')[0] ?? agent?.primaryModel?.split('/')[0] ?? '';
    const newModel = `${provider}/${modelId}`;
    setSwitchingModel(true);
    setShowModels(false);
    try {
      await configApi.update(agentId, { primaryModel: newModel });
      setCurrentModel(newModel);
    } catch { /* revert silently */ }
    finally {
      setSwitchingModel(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  const modelLabel = currentModel
    ? currentModel.split('/').pop() ?? currentModel
    : 'Select model';
  const provider = currentModel?.split('/')[0] ?? '';

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

      {/* Status banners */}
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
      {(wsState === 'error' || wsState === 'disconnected') && (
        <div className="mx-5 mt-4 p-4 rounded-xl border border-red-900/30 bg-red-900/10 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <AlertCircle size={16} className="text-red-400 flex-shrink-0" />
            <p className="text-sm text-red-300">{error ?? 'Connection lost'}</p>
          </div>
          <button className="btn-secondary text-xs px-3 py-1.5" onClick={connect}>
            <RefreshCw size={12} /> Reconnect
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
        {isTyping && (
          <div className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-xl bg-obsidian-700 flex items-center justify-center flex-shrink-0">
              <Bot size={13} className="text-muted" />
            </div>
            <div className="msg-agent">
              <div className="flex items-center gap-1 py-0.5">
                {[0, 150, 300].map(delay => (
                  <span
                    key={delay}
                    className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Scroll to bottom */}
      {!atBottom && (
        <button
          className="absolute right-6 bottom-32 w-8 h-8 rounded-full bg-obsidian-700 border border-border flex items-center justify-center shadow-card hover:bg-obsidian-600 transition-colors z-10"
          onClick={() => {
            if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }}
        >
          <ChevronDown size={14} className="text-muted" />
        </button>
      )}

      {/* ── Input area ───────────────────────────────────────────────────────── */}
      <div className="px-5 pb-5 pt-3 border-t border-border bg-obsidian-900/30">

        {/* Attachment chips */}
        {(attachments.length > 0 || uploading) && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map(att => (
              <div
                key={att.key}
                className="flex items-center gap-1.5 bg-obsidian-700 border border-border rounded-lg px-2.5 py-1 text-xs text-text"
              >
                <Paperclip size={11} className="text-muted flex-shrink-0" />
                <span className="truncate max-w-[140px]">{att.name}</span>
                <span className="text-muted">({formatBytes(att.size)})</span>
                <button
                  onClick={() => removeAttachment(att.key)}
                  className="ml-1 text-muted hover:text-red-400 transition-colors"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
            {uploading && (
              <div className="flex items-center gap-1.5 bg-obsidian-700 border border-border rounded-lg px-2.5 py-1 text-xs text-muted">
                <Loader2 size={11} className="animate-spin" /> Uploading...
              </div>
            )}
          </div>
        )}

        {/* Input box */}
        <div className={clsx(
          'bg-obsidian-800 border rounded-xl transition-all',
          wsState === 'connected'
            ? 'border-border focus-within:border-lava-500/50'
            : 'border-border opacity-60',
        )}>
          {/* Textarea */}
          <div className="px-3 pt-2.5">
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
              className="w-full bg-transparent text-sm text-text placeholder:text-muted
                         resize-none max-h-40 focus:outline-none leading-relaxed
                         disabled:cursor-not-allowed"
              style={{ minHeight: '24px' }}
              onInput={e => {
                const el = e.currentTarget;
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
              }}
            />
          </div>

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between px-2 py-1.5 gap-2">
            {/* Left: attach + model picker */}
            <div className="flex items-center gap-1">

              {/* Attach */}
              <button
                className={clsx(
                  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all',
                  wsState === 'connected'
                    ? 'text-muted hover:text-text hover:bg-obsidian-700'
                    : 'text-muted/40 cursor-not-allowed',
                )}
                onClick={() => wsState === 'connected' && fileInputRef.current?.click()}
                disabled={wsState !== 'connected' || uploading}
                title="Attach file"
              >
                {uploading
                  ? <Loader2 size={14} className="animate-spin" />
                  : <Paperclip size={14} />}
              </button>

              {/* LLM model picker */}
              <div className="relative" ref={modelPickerRef}>
                <button
                  className={clsx(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all max-w-[200px]',
                    wsState === 'connected'
                      ? 'text-muted hover:text-text hover:bg-obsidian-700'
                      : 'text-muted/40 cursor-not-allowed',
                  )}
                  onClick={() => wsState === 'connected' && setShowModels(s => !s)}
                  disabled={wsState !== 'connected' || switchingModel}
                  title="Switch model"
                >
                  {switchingModel
                    ? <Loader2 size={12} className="animate-spin flex-shrink-0" />
                    : <Zap size={12} className={clsx('flex-shrink-0', PROVIDER_COLORS[provider] ?? 'text-muted')} />
                  }
                  <span className="truncate font-mono">{modelLabel}</span>
                  <ChevronUp size={11} className={clsx(
                    'flex-shrink-0 transition-transform text-muted',
                    showModels && 'rotate-180',
                  )} />
                </button>

                {/* Model dropdown */}
                {showModels && models.length > 0 && (
                  <div className="absolute bottom-full left-0 mb-2 w-72 bg-obsidian-800 border border-border rounded-xl shadow-xl z-50 overflow-hidden">
                    <div className="px-3 py-2 border-b border-border">
                      <p className="text-xs font-semibold text-text">Switch Model</p>
                      <p className="text-[10px] text-muted mt-0.5">Takes effect on next message</p>
                    </div>
                    <div className="max-h-64 overflow-y-auto py-1">
                      {models.map(m => {
                        const isActive = currentModel.endsWith(m.id);
                        return (
                          <button
                            key={m.id}
                            className={clsx(
                              'w-full flex items-center justify-between px-3 py-2 text-left text-xs transition-colors',
                              isActive
                                ? 'bg-lava-500/10 text-lava-400'
                                : 'text-muted hover:text-text hover:bg-obsidian-700',
                            )}
                            onClick={() => handleModelSwitch(m.id)}
                          >
                            <div className="flex items-center gap-2">
                              <Zap size={11} className={isActive ? 'text-lava-400' : 'text-muted'} />
                              <span className="font-mono">{m.id}</span>
                              {m.isDefault && (
                                <span className="text-[9px] px-1 py-0.5 rounded bg-obsidian-600 text-muted">
                                  default
                                </span>
                              )}
                            </div>
                            {isActive && <Check size={12} className="text-lava-400" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Send */}
            <button
              className={clsx(
                'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-all',
                (input.trim() || attachments.length > 0) && wsState === 'connected'
                  ? 'bg-lava-500 text-white hover:bg-lava-400'
                  : 'bg-obsidian-700 text-muted cursor-not-allowed',
              )}
              onClick={handleSend}
              disabled={(!input.trim() && attachments.length === 0) || wsState !== 'connected'}
            >
              <Send size={14} />
            </button>
          </div>
        </div>

        <p className="text-[10px] text-muted mt-1.5 text-center">
          Enter to send · Shift+Enter for new line · Paperclip to attach files
        </p>

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          onChange={e => handleFileSelect(e.target.files)}
        />
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

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
    <div className={clsx('flex items-start gap-3 animate-slide-up', isUser && 'flex-row-reverse')}>
      <div className={clsx(
        'w-7 h-7 rounded-xl flex items-center justify-center flex-shrink-0',
        isUser ? 'bg-lava-500/20' : 'bg-obsidian-700',
      )}>
        {isUser
          ? <span className="text-xs text-lava-400 font-bold">Y</span>
          : <Bot size={13} className="text-muted" />}
      </div>
      <div className={clsx('max-w-[72%] flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
        <div className={isUser ? 'msg-user' : 'msg-agent'}>
          <p className="text-sm text-text leading-relaxed whitespace-pre-wrap">
            {message.content}
            {message.streaming && (
              <span className="inline-block w-0.5 h-4 bg-lava-400 ml-0.5 animate-pulse align-middle" />
            )}
          </p>
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-border/40">
              {message.attachments.map(att => (
                <div
                  key={att.key}
                  className="flex items-center gap-1 bg-obsidian-700/60 rounded-lg px-2 py-0.5 text-[10px] text-muted"
                >
                  <Paperclip size={9} />
                  <span className="truncate max-w-[100px]">{att.name}</span>
                </div>
              ))}
            </div>
          )}
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
        Start typing to begin your conversation. Use the paperclip to attach files or the model picker to switch LLMs mid-conversation.
      </p>
    </div>
  );
}
