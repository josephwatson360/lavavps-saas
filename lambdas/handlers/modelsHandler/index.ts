import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createLogger } from '../../layer/src/logger';
import { ok, badRequest, notFound, internalError } from '../../layer/src/response';

// ─────────────────────────────────────────────────────────────────────────────
// modelsHandler
//
// GET /agents/{agentId}/models
//
// Returns available models from the tenant's configured LLM provider.
// Results are cached in DynamoDB for 1 hour (TTL-based) to avoid
// hammering provider APIs on every portal load.
//
// Default model selection:
//   The portal pre-selects the least expensive model per provider.
//   This is defined in PROVIDER_DEFAULTS below.
// ─────────────────────────────────────────────────────────────────────────────

const logger   = createLogger('modelsHandler');
const secrets  = new SecretsManagerClient({});
const dynamo   = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.TABLE_NAME!;
const CACHE_TTL_SECONDS = 3600; // 1 hour

// Least expensive model per provider (portal pre-selects this)
const PROVIDER_DEFAULTS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5',
  openai:    'gpt-4o-mini',
  google:    'gemini-2.0-flash',
  xai:       'grok-3-mini',
  mistral:   'mistral-small-latest',
  cohere:    'command-r',
};

// Provider API endpoints for model listing
const PROVIDER_ENDPOINTS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1/models',
  openai:    'https://api.openai.com/v1/models',
  google:    'https://generativelanguage.googleapis.com/v1beta/models',
  xai:       'https://api.x.ai/v1/models',
  mistral:   'https://api.mistral.ai/v1/models',
  cohere:    'https://api.cohere.ai/v1/models',
};

interface ProviderModel {
  id:          string;
  name:        string;
  contextWindow?: number;
  isDefault:   boolean;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const tenantId = event.requestContext.authorizer?.claims?.['custom:tenant_id'] as string;
  const agentId  = event.pathParameters?.agentId;

  if (!tenantId || !agentId) return badRequest('Missing tenant or agent context');

  // Get agent record
  const agentResult = await dynamo.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
  }));

  if (!agentResult.Item || agentResult.Item.tenant_id !== tenantId) {
    return notFound('Agent');
  }

  const item     = agentResult.Item;
  const provider = item.llm_provider as string | undefined;

  if (!provider) {
    return ok({
      models:          [],
      provider:        null,
      message:         'No LLM provider configured. Add an API key to see available models.',
      tokenPurchaseUrl: null,
    });
  }

  // Check cache
  const cacheKey   = `model_cache_${provider}`;
  const cacheValue = item[cacheKey] as string | undefined;
  const cacheTtl   = item[`${cacheKey}_ttl`] as number | undefined;
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (cacheValue && cacheTtl && cacheTtl > nowSeconds) {
    return ok({
      models:          JSON.parse(cacheValue),
      provider,
      defaultModel:    PROVIDER_DEFAULTS[provider] ?? null,
      tokenPurchaseUrl: getTokenPurchaseUrl(provider),
      fromCache:       true,
    });
  }

  // Fetch API key from Secrets Manager
  if (!item.llm_secret_arn) {
    return ok({ models: [], provider, message: 'API key not configured' });
  }

  let apiKey: string;
  try {
    const secretResult = await secrets.send(new GetSecretValueCommand({
      SecretId: item.llm_secret_arn as string,
    }));
    const secretData = JSON.parse(secretResult.SecretString ?? '{}');
    apiKey = secretData.apiKey;
  } catch {
    return ok({ models: [], provider, message: 'Could not retrieve API key. Please re-enter your key.' });
  }

  // Fetch models from provider
  let models: ProviderModel[] = [];
  try {
    models = await fetchModels(provider, apiKey);
  } catch (err) {
    logger.warn('Failed to fetch models from provider', {
      tenant_id: tenantId,
      agent_id:  agentId,
      provider,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return ok({
      models:          [],
      provider,
      message:         'Could not fetch models from provider. Your API key may be invalid.',
      tokenPurchaseUrl: getTokenPurchaseUrl(provider),
    });
  }

  // Cache result in DynamoDB
  await dynamo.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
    UpdateExpression: 'SET #cache = :v, #cacheTtl = :ttl',
    ExpressionAttributeNames: {
      '#cache':    cacheKey,
      '#cacheTtl': `${cacheKey}_ttl`,
    },
    ExpressionAttributeValues: {
      ':v':   JSON.stringify(models),
      ':ttl': nowSeconds + CACHE_TTL_SECONDS,
    },
  }));

  return ok({
    models,
    provider,
    defaultModel:     PROVIDER_DEFAULTS[provider] ?? null,
    tokenPurchaseUrl: getTokenPurchaseUrl(provider),
    fromCache:        false,
  });
};

// ── Provider-specific model fetchers ─────────────────────────────────────────

async function fetchModels(provider: string, apiKey: string): Promise<ProviderModel[]> {
  const endpoint = PROVIDER_ENDPOINTS[provider];
  if (!endpoint) return [];

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (provider === 'anthropic') {
    headers['x-api-key']         = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider === 'google') {
    // Gemini uses query param
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const url     = provider === 'google' ? `${endpoint}?key=${apiKey}` : endpoint;
  const resp    = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });

  if (!resp.ok) {
    throw new Error(`Provider API returned ${resp.status}`);
  }

  const data = await resp.json() as Record<string, unknown>;
  return parseModels(provider, data);
}

function parseModels(provider: string, data: Record<string, unknown>): ProviderModel[] {
  const defaultId = PROVIDER_DEFAULTS[provider] ?? '';

  if (provider === 'anthropic') {
    const items = (data.data as Array<Record<string, unknown>>) ?? [];
    return items
      .filter(m => typeof m.id === 'string' && (m.id as string).startsWith('claude'))
      .map(m => ({
        id:        m.id as string,
        name:      (m.display_name ?? m.id) as string,
        isDefault: (m.id as string).includes(defaultId),
      }));
  }

  if (provider === 'openai') {
    const items = (data.data as Array<Record<string, unknown>>) ?? [];
    return items
      .filter(m => typeof m.id === 'string' && /^gpt/.test(m.id as string))
      .map(m => ({
        id:        m.id as string,
        name:      m.id as string,
        isDefault: (m.id as string).includes(defaultId),
      }));
  }

  if (provider === 'google') {
    const items = (data.models as Array<Record<string, unknown>>) ?? [];
    return items
      .filter(m => {
        const name = m.name as string ?? '';
        return name.includes('gemini') && !name.includes('embedding');
      })
      .map(m => {
        const id = (m.name as string).replace('models/', '');
        return {
          id,
          name:      (m.displayName ?? id) as string,
          isDefault: id.includes(defaultId),
        };
      });
  }

  // Generic fallback (xAI, Mistral, Cohere — all follow OpenAI format)
  const items = (data.data as Array<Record<string, unknown>>) ?? [];
  return items.map(m => ({
    id:        m.id as string,
    name:      (m.name ?? m.id) as string,
    isDefault: (m.id as string).includes(defaultId),
  }));
}

function getTokenPurchaseUrl(provider: string): string | null {
  const urls: Record<string, string> = {
    anthropic: 'https://console.anthropic.com/settings/billing',
    openai:    'https://platform.openai.com/settings/billing',
    google:    'https://aistudio.google.com/apikey',
    xai:       'https://console.x.ai/billing',
    mistral:   'https://console.mistral.ai/billing',
    cohere:    'https://dashboard.cohere.com/billing',
  };
  return urls[provider] ?? null;
}
