import axios, { AxiosInstance } from 'axios';
import { fetchAuthSession } from 'aws-amplify/auth';
import { API_BASE } from '@/aws-exports';
import type {
  Agent, AgentConfig, AgentConfigResponse, ModelsResponse,
  StatusResponse, FilesResponse, Job,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// API Client — Axios with auto-attach Cognito JWT
// ─────────────────────────────────────────────────────────────────────────────

function createApiClient(): AxiosInstance {
  const client = axios.create({
    baseURL: API_BASE,
    timeout: 30_000,
    headers: { 'Content-Type': 'application/json' },
  });

  // Auto-attach JWT on every request
  client.interceptors.request.use(async (config) => {
    try {
      const session = await fetchAuthSession();
      const token   = session.tokens?.accessToken?.toString();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    } catch {
      // Not authenticated — request will return 401
    }
    return config;
  });

  // Standard error handling
  client.interceptors.response.use(
    (res) => res,
    (err) => {
      if (err.response?.status === 401) {
        // Token expired or invalid — Amplify Auth will handle refresh
        window.location.href = '/login';
      }
      return Promise.reject(err);
    },
  );

  return client;
}

const api = createApiClient();

// ── Agents ────────────────────────────────────────────────────────────────────

export const agentsApi = {
  list: () =>
    api.get<{ agents: Agent[]; count: number }>('/agents').then(r => r.data),

  get: (agentId: string) =>
    api.get<Agent>(`/agents/${agentId}`).then(r => r.data),

  create: (name?: string) =>
    api.post<{ agentId: string; status: string; message: string }>(
      '/agents', { name }).then(r => r.data),

  delete: (agentId: string) =>
    api.delete(`/agents/${agentId}`),

  getStatus: (agentId: string) =>
    api.get<StatusResponse>(`/agents/${agentId}/status`).then(r => r.data),

  start: (agentId: string) =>
    api.post<StatusResponse>(`/agents/${agentId}/start`).then(r => r.data),

  stop: (agentId: string) =>
    api.post<StatusResponse>(`/agents/${agentId}/stop`).then(r => r.data),
};

// ── Config ────────────────────────────────────────────────────────────────────

export const configApi = {
  get: (agentId: string) =>
    api.get<AgentConfigResponse>(`/agents/${agentId}/config`).then(r => r.data),

  update: (agentId: string, config: Partial<AgentConfig>) =>
    api.put<{ message: string; fieldsUpdated: string[] }>(
      `/agents/${agentId}/config`, config).then(r => r.data),
};

// ── Keys ──────────────────────────────────────────────────────────────────────

export const keysApi = {
  store: (agentId: string, provider: string, apiKey: string) =>
    api.post<{ message: string; provider: string }>(
      `/agents/${agentId}/keys`, { provider, apiKey }).then(r => r.data),

  delete: (agentId: string) =>
    api.delete(`/agents/${agentId}/keys`),
};

// ── Models ────────────────────────────────────────────────────────────────────

export const modelsApi = {
  list: (agentId: string) =>
    api.get<ModelsResponse>(`/agents/${agentId}/models`).then(r => r.data),
};

// ── Channels ──────────────────────────────────────────────────────────────────

export const channelsApi = {
  update: (agentId: string, channels: {
    discord?:  { botToken: string; guildId?: string };
    telegram?: { botToken: string };
    whatsapp?: { phoneNumberId: string; accessToken: string };
  }) => api.put<{ message: string; channels: string[] }>(
      `/agents/${agentId}/channels`, channels).then(r => r.data),

  delete: (agentId: string, channelName: string) =>
    api.delete(`/agents/${agentId}/channels/${channelName}`),
};

// ── Files ─────────────────────────────────────────────────────────────────────

export const filesApi = {
  list: (agentId: string) =>
    api.get<FilesResponse>(`/agents/${agentId}/files`).then(r => r.data),

  getUploadUrl: (agentId: string, filename: string, size: number, contentType?: string) =>
    api.post<{ uploadUrl: string; key: string; expiresIn: number }>(
      `/agents/${agentId}/files`, { filename, size, contentType }).then(r => r.data),

  getDownloadUrl: (agentId: string, fileKey: string) =>
    api.get<{ downloadUrl: string; expiresIn: number }>(
      `/agents/${agentId}/files/${encodeURIComponent(fileKey)}`).then(r => r.data),

  delete: (agentId: string, fileKey: string) =>
    api.delete(`/agents/${agentId}/files/${encodeURIComponent(fileKey)}`),

  // Upload directly to presigned S3 URL
  uploadToS3: async (uploadUrl: string, file: File) => {
    await fetch(uploadUrl, {
      method:  'PUT',
      body:    file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    });
  },
};

// ── Jobs ──────────────────────────────────────────────────────────────────────

export const jobsApi = {
  list: (agentId: string) =>
    api.get<{ jobs: Job[] }>(`/agents/${agentId}/jobs`).then(r => r.data),

  create: (agentId: string, params: { title: string; tasks: string; maxIterations?: number }) =>
    api.post<{ jobId: string; status: string; maxIterations: number; message: string }>(
      `/agents/${agentId}/jobs`, params).then(r => r.data),

  get: (agentId: string, jobId: string) =>
    api.get<Job>(`/agents/${agentId}/jobs/${jobId}`).then(r => r.data),

  cancel: (agentId: string, jobId: string) =>
    api.delete(`/agents/${agentId}/jobs/${jobId}`),
};

export default api;
