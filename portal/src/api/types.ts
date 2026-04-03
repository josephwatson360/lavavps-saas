// ─────────────────────────────────────────────────────────────────────────────
// LavaVPS Portal — Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

export type PlanCode = 'starter' | 'pro' | 'business';

export type AgentStatus =
  | 'PROVISIONING'
  | 'STOPPED'
  | 'STARTING'
  | 'RUNNING'
  | 'SUSPENDED'
  | 'DELETING';

export interface Agent {
  agentId:         string;
  name:            string;
  status:          AgentStatus;
  planCode:        PlanCode;
  primaryModel:    string | null;
  onboardingDone:  boolean;
  configVersion:   number;
  storageQuotaGb:  number;
  storageUsedBytes: number;
  createdAt:       string;
  lastActivityAt:  string | null;
  taskArn:         string | null;
}

export interface AgentConfig {
  systemPrompt?:        string;
  primaryModel?:        string;
  temperature?:         number;
  maxTokens?:           number;
  agentName?:           string;
  sessionResetMode?:    'daily' | 'idle' | 'never';
  sessionIdleMinutes?:  number;
  discordBotToken?:     string;
  discordGuildId?:      string;
  telegramBotToken?:    string;
  whatsappPhoneNumberId?: string;
  whatsappAccessToken?: string;
  ralphLoopMaxIterations?: number;
}

export interface AgentConfigResponse {
  agentId:       string;
  config:        AgentConfig;
  configVersion: number;
  lastUpdated:   string | null;
}

export interface ProviderModel {
  id:        string;
  name:      string;
  isDefault: boolean;
}

export interface ModelsResponse {
  models:           ProviderModel[];
  provider:         string | null;
  defaultModel:     string | null;
  tokenPurchaseUrl: string | null;
  message?:         string;
}

export interface StatusResponse {
  status:         AgentStatus;
  agentId:        string;
  taskArn:        string | null;
  lastActivityAt: string | null;
}

export interface WorkspaceFile {
  key:          string;
  size:         number;
  lastModified: string;
}

export interface FilesResponse {
  files:            WorkspaceFile[];
  storageQuotaGb:   number;
  storageUsedGb:    number;
  storageUsedBytes: number;
  count:            number;
}

export interface Job {
  jobId:          string;
  title:          string;
  status:         'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  maxIterations:  number;
  iterationCount: number;
  createdAt:      string;
  updatedAt:      string;
  completedAt:    string | null;
  result:         string | null;
}

// Chat message types
export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id:        string;
  role:      MessageRole;
  content:   string;
  timestamp: number;
  streaming?: boolean;
}

// Auth / Tenant context
export interface TenantContext {
  tenantId: string;
  planCode: PlanCode;
  role:     'owner' | 'member';
  sub:      string;
  email:    string;
}
