"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const logger_1 = require("./logger");
const response_1 = require("./response");
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
const logger = (0, logger_1.createLogger)('modelsHandler');
const secrets = new client_secrets_manager_1.SecretsManagerClient({});
const dynamo = lib_dynamodb_1.DynamoDBDocumentClient.from(new client_dynamodb_1.DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;
const CACHE_TTL_SECONDS = 3600; // 1 hour
// Least expensive model per provider (portal pre-selects this)
const PROVIDER_DEFAULTS = {
    anthropic: 'claude-haiku-4-5',
    openai: 'gpt-4o-mini',
    google: 'gemini-2.0-flash',
    xai: 'grok-3-mini',
    mistral: 'mistral-small-latest',
    cohere: 'command-r',
};
// Provider API endpoints for model listing
const PROVIDER_ENDPOINTS = {
    anthropic: 'https://api.anthropic.com/v1/models',
    openai: 'https://api.openai.com/v1/models',
    google: 'https://generativelanguage.googleapis.com/v1beta/models',
    xai: 'https://api.x.ai/v1/models',
    mistral: 'https://api.mistral.ai/v1/models',
    cohere: 'https://api.cohere.ai/v1/models',
};
const handler = async (event) => {
    const tenantId = event.requestContext.authorizer?.tenantId;
    const agentId = event.pathParameters?.agentId;
    if (!tenantId || !agentId)
        return (0, response_1.badRequest)('Missing tenant or agent context');
    // Get agent record
    const agentResult = await dynamo.send(new lib_dynamodb_1.GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
    }));
    if (!agentResult.Item || agentResult.Item.tenant_id !== tenantId) {
        return (0, response_1.notFound)('Agent');
    }
    const item = agentResult.Item;
    const provider = item.llm_provider;
    if (!provider) {
        return (0, response_1.ok)({
            models: [],
            provider: null,
            message: 'No LLM provider configured. Add an API key to see available models.',
            tokenPurchaseUrl: null,
        });
    }
    // Check cache
    const cacheKey = `model_cache_${provider}`;
    const cacheValue = item[cacheKey];
    const cacheTtl = item[`${cacheKey}_ttl`];
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (cacheValue && cacheTtl && cacheTtl > nowSeconds) {
        return (0, response_1.ok)({
            models: JSON.parse(cacheValue),
            provider,
            defaultModel: PROVIDER_DEFAULTS[provider] ?? null,
            tokenPurchaseUrl: getTokenPurchaseUrl(provider),
            fromCache: true,
        });
    }
    // Fetch API key from Secrets Manager
    if (!item.llm_secret_arn) {
        return (0, response_1.ok)({ models: [], provider, message: 'API key not configured' });
    }
    let apiKey;
    try {
        const secretResult = await secrets.send(new client_secrets_manager_1.GetSecretValueCommand({
            SecretId: item.llm_secret_arn,
        }));
        const secretData = JSON.parse(secretResult.SecretString ?? '{}');
        apiKey = secretData.apiKey;
    }
    catch {
        return (0, response_1.ok)({ models: [], provider, message: 'Could not retrieve API key. Please re-enter your key.' });
    }
    // Fetch models from provider
    let models = [];
    try {
        models = await fetchModels(provider, apiKey);
    }
    catch (err) {
        logger.warn('Failed to fetch models from provider', {
            tenant_id: tenantId,
            agent_id: agentId,
            provider,
            error: err instanceof Error ? err.message : 'unknown',
        });
        return (0, response_1.ok)({
            models: [],
            provider,
            message: 'Could not fetch models from provider. Your API key may be invalid.',
            tokenPurchaseUrl: getTokenPurchaseUrl(provider),
        });
    }
    // Cache result in DynamoDB
    await dynamo.send(new lib_dynamodb_1.UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
        UpdateExpression: 'SET #cache = :v, #cacheTtl = :ttl',
        ExpressionAttributeNames: {
            '#cache': cacheKey,
            '#cacheTtl': `${cacheKey}_ttl`,
        },
        ExpressionAttributeValues: {
            ':v': JSON.stringify(models),
            ':ttl': nowSeconds + CACHE_TTL_SECONDS,
        },
    }));
    return (0, response_1.ok)({
        models,
        provider,
        defaultModel: PROVIDER_DEFAULTS[provider] ?? null,
        tokenPurchaseUrl: getTokenPurchaseUrl(provider),
        fromCache: false,
    });
};
exports.handler = handler;
// ── Provider-specific model fetchers ─────────────────────────────────────────
async function fetchModels(provider, apiKey) {
    const endpoint = PROVIDER_ENDPOINTS[provider];
    if (!endpoint)
        return [];
    const headers = { 'Content-Type': 'application/json' };
    if (provider === 'anthropic') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
    }
    else if (provider === 'google') {
        // Gemini uses query param
    }
    else {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const url = provider === 'google' ? `${endpoint}?key=${apiKey}` : endpoint;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
        throw new Error(`Provider API returned ${resp.status}`);
    }
    const data = await resp.json();
    return parseModels(provider, data);
}
function parseModels(provider, data) {
    const defaultId = PROVIDER_DEFAULTS[provider] ?? '';
    if (provider === 'anthropic') {
        const items = data.data ?? [];
        return items
            .filter(m => typeof m.id === 'string' && m.id.startsWith('claude'))
            .map(m => ({
            id: m.id,
            name: (m.display_name ?? m.id),
            isDefault: m.id.includes(defaultId),
        }));
    }
    if (provider === 'openai') {
        const items = data.data ?? [];
        return items
            .filter(m => typeof m.id === 'string' && /^gpt/.test(m.id))
            .map(m => ({
            id: m.id,
            name: m.id,
            isDefault: m.id.includes(defaultId),
        }));
    }
    if (provider === 'google') {
        const items = data.models ?? [];
        return items
            .filter(m => {
            const name = m.name ?? '';
            return name.includes('gemini') && !name.includes('embedding');
        })
            .map(m => {
            const id = m.name.replace('models/', '');
            return {
                id,
                name: (m.displayName ?? id),
                isDefault: id.includes(defaultId),
            };
        });
    }
    // Generic fallback (xAI, Mistral, Cohere — all follow OpenAI format)
    const items = data.data ?? [];
    return items.map(m => ({
        id: m.id,
        name: (m.name ?? m.id),
        isDefault: m.id.includes(defaultId),
    }));
}
function getTokenPurchaseUrl(provider) {
    const urls = {
        anthropic: 'https://console.anthropic.com/settings/billing',
        openai: 'https://platform.openai.com/settings/billing',
        google: 'https://aistudio.google.com/apikey',
        xai: 'https://console.x.ai/billing',
        mistral: 'https://console.mistral.ai/billing',
        cohere: 'https://dashboard.cohere.com/billing',
    };
    return urls[provider] ?? null;
}
