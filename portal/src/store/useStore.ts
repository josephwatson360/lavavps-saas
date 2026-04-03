import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { Agent, TenantContext, ChatMessage } from '@/api/types';

// ─────────────────────────────────────────────────────────────────────────────
// LavaVPS Portal — Zustand Global Store
// ─────────────────────────────────────────────────────────────────────────────

interface PortalState {
  // Auth / tenant
  tenant:    TenantContext | null;
  setTenant: (t: TenantContext | null) => void;

  // Agents
  agents:     Agent[];
  setAgents:  (agents: Agent[]) => void;
  updateAgent: (agentId: string, updates: Partial<Agent>) => void;

  // Active agent (in chat or config view)
  activeAgentId: string | null;
  setActiveAgentId: (id: string | null) => void;

  // Chat messages per agent
  messages:       Record<string, ChatMessage[]>;
  addMessage:     (agentId: string, msg: ChatMessage) => void;
  updateMessage:  (agentId: string, msgId: string, updates: Partial<ChatMessage>) => void;
  clearMessages:  (agentId: string) => void;

  // UI state
  sidebarOpen:    boolean;
  setSidebarOpen: (open: boolean) => void;

  // Notifications / toasts
  toasts:    Toast[];
  addToast:  (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
}

export interface Toast {
  id:       string;
  type:     'success' | 'error' | 'info' | 'warning';
  message:  string;
  duration?: number;
}

let toastCounter = 0;

export const useStore = create<PortalState>()(
  devtools((set, get) => ({
    // Auth
    tenant:    null,
    setTenant: (tenant) => set({ tenant }),

    // Agents
    agents:    [],
    setAgents: (agents) => set({ agents }),
    updateAgent: (agentId, updates) =>
      set(state => ({
        agents: state.agents.map(a => a.agentId === agentId ? { ...a, ...updates } : a),
      })),

    // Active agent
    activeAgentId:    null,
    setActiveAgentId: (id) => set({ activeAgentId: id }),

    // Chat messages
    messages:      {},
    addMessage:    (agentId, msg) =>
      set(state => ({
        messages: {
          ...state.messages,
          [agentId]: [...(state.messages[agentId] ?? []), msg],
        },
      })),
    updateMessage: (agentId, msgId, updates) =>
      set(state => ({
        messages: {
          ...state.messages,
          [agentId]: (state.messages[agentId] ?? []).map(m =>
            m.id === msgId ? { ...m, ...updates } : m),
        },
      })),
    clearMessages: (agentId) =>
      set(state => ({
        messages: { ...state.messages, [agentId]: [] },
      })),

    // UI
    sidebarOpen:    false,
    setSidebarOpen: (open) => set({ sidebarOpen: open }),

    // Toasts
    toasts:    [],
    addToast:  (toast) => {
      const id = `toast-${++toastCounter}`;
      set(state => ({ toasts: [...state.toasts, { ...toast, id }] }));
      const duration = toast.duration ?? (toast.type === 'error' ? 6000 : 3500);
      setTimeout(() => get().removeToast(id), duration);
    },
    removeToast: (id) =>
      set(state => ({ toasts: state.toasts.filter(t => t.id !== id) })),
  })),
);

// Convenience toast helpers
export const toast = {
  success: (message: string) => useStore.getState().addToast({ type: 'success', message }),
  error:   (message: string) => useStore.getState().addToast({ type: 'error',   message }),
  info:    (message: string) => useStore.getState().addToast({ type: 'info',    message }),
  warning: (message: string) => useStore.getState().addToast({ type: 'warning', message }),
};
