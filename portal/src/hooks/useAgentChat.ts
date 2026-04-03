import { useEffect, useRef, useCallback, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { WS_ENDPOINT } from '@/aws-exports';
import { agentsApi } from '@/api/client';
import { useStore } from '@/store/useStore';
import type { AgentStatus, ChatMessage } from '@/api/types';

// ─────────────────────────────────────────────────────────────────────────────
// useAgentChat — WebSocket chat hook
//
// Pre-wake flow:
//   1. Check agent status via REST
//   2. If STOPPED → POST /start → poll /readyz (via taskHandler) → open WS
//   3. If RUNNING → open WS immediately
//
// Auto-focus requirement: input must be focused at all times.
// The inputRef returned here should be attached to the chat textarea.
// After every agent response, re-focus the input automatically.
// ─────────────────────────────────────────────────────────────────────────────

type WsState = 'idle' | 'waking' | 'connecting' | 'connected' | 'error' | 'disconnected';

interface UseAgentChatOptions {
  agentId: string;
}

export function useAgentChat({ agentId }: UseAgentChatOptions) {
  const [wsState, setWsState]       = useState<WsState>('idle');
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('STOPPED');
  const [error, setError]           = useState<string | null>(null);
  const [isTyping, setIsTyping]     = useState(false); // agent is composing

  const wsRef   = useRef<WebSocket | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { addMessage, updateMessage } = useStore();

  // ── Connect to agent WebSocket ─────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setError(null);
    setWsState('waking');

    // Step 1: Check / wake the agent
    let status: AgentStatus = 'STOPPED';
    try {
      const s = await agentsApi.getStatus(agentId);
      status  = s.status;
      setAgentStatus(status);
    } catch {
      setError('Could not check agent status.');
      setWsState('error');
      return;
    }

    if (status === 'STOPPED' || status === 'STARTING') {
      try {
        const started = await agentsApi.start(agentId);
        status = started.status;
        setAgentStatus(status);
      } catch {
        setError('Failed to start agent. Please try again.');
        setWsState('error');
        return;
      }
    }

    if (status !== 'RUNNING') {
      setError(`Agent is ${status}. Please contact support if this persists.`);
      setWsState('error');
      return;
    }

    // Step 2: Open WebSocket with JWT as query param
    setWsState('connecting');

    let token = '';
    try {
      const session = await fetchAuthSession();
      token = session.tokens?.accessToken?.toString() ?? '';
    } catch {
      setError('Authentication error. Please refresh.');
      setWsState('error');
      return;
    }

    const url = `${WS_ENDPOINT}?agentId=${agentId}&token=${encodeURIComponent(token)}`;
    const ws  = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsState('connected');
      setAgentStatus('RUNNING');
      // Auto-focus input immediately on connection
      setTimeout(() => inputRef.current?.focus(), 50);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);

        if (data.type === 'typing' || data.type === 'thinking') {
          setIsTyping(true);
          return;
        }

        if (data.type === 'chunk' && data.messageId) {
          // Streaming chunk — append to existing message or create new
          const store = useStore.getState();
          const msgs  = store.messages[agentId] ?? [];
          const existing = msgs.find(m => m.id === data.messageId);
          if (existing) {
            updateMessage(agentId, data.messageId, {
              content: existing.content + (data.content ?? ''),
            });
          } else {
            addMessage(agentId, {
              id:        data.messageId,
              role:      'assistant',
              content:   data.content ?? '',
              timestamp: Date.now(),
              streaming: true,
            });
          }
          return;
        }

        if (data.type === 'done' && data.messageId) {
          setIsTyping(false);
          updateMessage(agentId, data.messageId, { streaming: false });
          // Re-focus input after response complete
          setTimeout(() => inputRef.current?.focus(), 50);
          return;
        }

        // Non-streaming response
        if (data.content || data.text || data.message) {
          setIsTyping(false);
          addMessage(agentId, {
            id:        `msg-${Date.now()}`,
            role:      'assistant',
            content:   data.content ?? data.text ?? data.message ?? '',
            timestamp: Date.now(),
          });
          // Re-focus input after response
          setTimeout(() => inputRef.current?.focus(), 50);
        }
      } catch {
        // Non-JSON message — treat as plain text response
        setIsTyping(false);
        addMessage(agentId, {
          id:        `msg-${Date.now()}`,
          role:      'assistant',
          content:   event.data as string,
          timestamp: Date.now(),
        });
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    };

    ws.onerror = () => {
      setWsState('error');
      setError('Connection error. Click to reconnect.');
      setIsTyping(false);
    };

    ws.onclose = (e) => {
      setWsState('disconnected');
      setIsTyping(false);
      // Auto-reconnect unless deliberately closed (code 1000)
      if (e.code !== 1000) {
        setTimeout(() => connect(), 3000);
      }
    };
  }, [agentId, addMessage, updateMessage]);

  // ── Send message ───────────────────────────────────────────────────────────
  const sendMessage = useCallback((content: string) => {
    if (!content.trim()) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      connect();
      return;
    }

    const msgId = `user-${Date.now()}`;
    addMessage(agentId, {
      id:        msgId,
      role:      'user',
      content:   content.trim(),
      timestamp: Date.now(),
    });

    wsRef.current.send(JSON.stringify({ action: 'message', content: content.trim() }));
    setIsTyping(true);
  }, [agentId, addMessage, connect]);

  // ── Disconnect ─────────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    wsRef.current?.close(1000, 'user disconnected');
    wsRef.current = null;
    setWsState('idle');
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    connect();
    return () => { wsRef.current?.close(1000, 'component unmount'); };
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    wsState,
    agentStatus,
    isTyping,
    error,
    inputRef,
    connect,
    disconnect,
    sendMessage,
  };
}
