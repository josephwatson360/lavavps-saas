"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_s3_1 = require("@aws-sdk/client-s3");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const client_lambda_1 = require("@aws-sdk/client-lambda");
const logger_1 = require("./logger");
// ─────────────────────────────────────────────────────────────────────────────
// configRenderer
//
// Internal Lambda — invoked async by configHandler and provisioningLambda.
// NEVER invoked directly by tenants or the portal.
//
// Security model:
//   1. Reads tenant config values from DynamoDB (individual typed fields)
//   2. Builds openclaw.json from LOCKED BASE TEMPLATE + tenant values
//   3. Validates the complete rendered JSON against OpenClaw schema
//   4. On validation failure: CloudWatch error logged, S3/EFS NOT written,
//      running agent untouched
//   5. On success: writes to S3, increments version, invokes bootstrapperLambda
//
// Locked fields (tenant CANNOT change these, ever):
//   gateway.bind, gateway.port, gateway.auth.mode = trusted-proxy
//   gateway.trustedProxies (ALB public subnet CIDRs)
//   gateway.auth.trustedProxy.userHeader = x-amzn-oidc-identity
//   agents.defaults.heartbeat.every = 1h (platform-wide, not per-tenant)
//   agents.defaults.heartbeat.target = none
//   agents.defaults.heartbeat.model = ollama/llama3.2:1b
//   agents.defaults.sandbox.mode = off (Fargate micro-VM: no Docker-in-Docker)
//   agents.defaults.workspace = /home/node/.openclaw/workspace
//   providers.ollama.baseUrl (internal Ollama ALB DNS)
// ─────────────────────────────────────────────────────────────────────────────
const logger = (0, logger_1.createLogger)('configRenderer');
const s3 = new client_s3_1.S3Client({});
const dynamo = lib_dynamodb_1.DynamoDBDocumentClient.from(new client_dynamodb_1.DynamoDBClient({}));
const lambda = new client_lambda_1.LambdaClient({});
const TABLE_NAME = process.env.TABLE_NAME;
const CONFIG_BUCKET = process.env.CONFIG_BUCKET;
const BOOTSTRAPPER_ARN = process.env.BOOTSTRAPPER_ARN;
const OLLAMA_ALB_DNS = process.env.OLLAMA_ALB_DNS;
const TRUSTED_PROXIES = process.env.TRUSTED_PROXIES.split(','); // "10.100.0.0/24,10.100.1.0/24"
const OPENCLAW_PORT = parseInt(process.env.OPENCLAW_PORT ?? '18789');
// ── Handler ───────────────────────────────────────────────────────────────────
const handler = async (event) => {
    const { tenantId, agentId } = event;
    if (!tenantId || !agentId) {
        logger.error('Missing tenantId or agentId in event', { event });
        return;
    }
    // Fetch current config version for error logging
    const agentResult = await dynamo.send(new lib_dynamodb_1.GetCommand({
        TableName: TABLE_NAME,
        Key: {
            pk: `TENANT#${tenantId}`,
            sk: `AGENT#${agentId}`,
        },
    }));
    if (!agentResult.Item) {
        logger.error('Agent not found in DynamoDB', { tenant_id: tenantId, agent_id: agentId });
        return;
    }
    const item = agentResult.Item;
    const configVersionAttempted = (item.config_version ?? 0);
    const priorValidVersion = (item.last_valid_config_version ?? 0);
    // ── Step 1: Build openclaw.json from LOCKED base template ─────────────────
    // These values are HARDCODED here. They cannot be overridden by DynamoDB values.
    const config = {
        gateway: {
            bind: 'lan',
            port: OPENCLAW_PORT,
            trustedProxies: TRUSTED_PROXIES, // ALB public subnet CIDRs from env var
            auth: {
                mode: 'trusted-proxy', // LOCKED: ALB Cognito auth is the gate
                trustedProxy: {
                    userHeader: 'x-amzn-oidc-identity', // LOCKED: ALB injects this
                    requiredHeaders: ['x-amzn-oidc-access-token'],
                },
            },
            reload: {
                mode: 'hybrid', // LOCKED: hot-apply safe changes, restart when needed
            },
        },
        agents: {
            defaults: {
                workspace: '/home/node/.openclaw/workspace', // LOCKED: EFS mount path
                heartbeat: {
                    every: '1h', // LOCKED: platform-wide, not per-tenant
                    target: 'none', // LOCKED: heartbeat runs silently
                    model: 'ollama/llama3.2:1b', // LOCKED: internal Ollama, no customer API tokens
                },
                sandbox: {
                    mode: 'off', // LOCKED: Fargate micro-VM; no Docker-in-Docker
                },
                compaction: {
                    notifyUser: false, // LOCKED: suppress "compacting context..." noise
                },
            },
        },
        providers: {
            ollama: {
                baseUrl: `http://${OLLAMA_ALB_DNS}:11434`, // LOCKED: internal Ollama ALB
            },
        },
    };
    // ── Step 2: Merge allowed tenant values into designated injection points ───
    // Only the fields listed in configHandler's ALLOWED_FIELDS are sourced from DynamoDB.
    // No other DynamoDB field can influence the rendered config.
    // Primary LLM model
    if (item.config_primaryModel) {
        config.agents.defaults.model = {
            primary: item.config_primaryModel,
        };
    }
    // System prompt
    if (item.config_systemPrompt) {
        config.agents.defaults.systemPrompt = item.config_systemPrompt;
    }
    // Temperature
    if (item.config_temperature !== undefined) {
        config.agents.defaults.temperature = item.config_temperature;
    }
    // Max tokens (floor 256 enforced by configHandler; no plan ceiling)
    if (item.config_maxTokens !== undefined) {
        config.agents.defaults.maxTokens = item.config_maxTokens;
    }
    // Agent name
    if (item.config_agentName) {
        config.agents.defaults.agentName = item.config_agentName;
    }
    // Session reset mode
    if (item.config_sessionResetMode) {
        config.agents.defaults.session = {
            reset: {
                mode: item.config_sessionResetMode,
                ...(item.config_sessionResetMode === 'idle' && item.config_sessionIdleMinutes
                    ? { idleMinutes: item.config_sessionIdleMinutes }
                    : {}),
            },
        };
    }
    // Channel integrations - only add section if credentials exist
    const channels = {};
    let hasChannels = false;
    if (item.config_discordBotToken) {
        channels.discord = {
            enabled: true,
            botToken: item.config_discordBotToken,
            ...(item.config_discordGuildId ? { guildId: item.config_discordGuildId } : {}),
        };
        hasChannels = true;
    }
    if (item.config_telegramBotToken) {
        channels.telegram = {
            enabled: true,
            botToken: item.config_telegramBotToken,
        };
        hasChannels = true;
    }
    if (item.config_whatsappPhoneNumberId && item.config_whatsappAccessToken) {
        channels.whatsapp = {
            enabled: true,
            phoneNumberId: item.config_whatsappPhoneNumberId,
            accessToken: item.config_whatsappAccessToken,
        };
        hasChannels = true;
    }
    if (hasChannels) {
        config.channels = channels;
    }
    // ── Step 3: Validate rendered config ─────────────────────────────────────
    const validationErrors = validateOpenClawConfig(config);
    if (validationErrors.length > 0) {
        // CRITICAL: Log errors but do NOT write to S3 or EFS.
        // The running agent continues with its prior valid config.
        logger.configValidationFailed({
            tenant_id: tenantId,
            agent_id: agentId,
            config_version_attempted: configVersionAttempted,
            prior_valid_version: priorValidVersion,
            validation_errors: validationErrors,
        });
        return; // Exit without writing anything
    }
    // ── Step 4: Write validated config to S3 ─────────────────────────────────
    const configJson = JSON.stringify(config, null, 2);
    const s3Key = `${tenantId}/${agentId}/openclaw.json`;
    try {
        await s3.send(new client_s3_1.PutObjectCommand({
            Bucket: CONFIG_BUCKET,
            Key: s3Key,
            Body: configJson,
            ContentType: 'application/json',
            Metadata: {
                'tenant-id': tenantId,
                'agent-id': agentId,
                'config-version': String(configVersionAttempted),
            },
        }));
    }
    catch (err) {
        logger.error('Failed to write config to S3', {
            tenant_id: tenantId,
            agent_id: agentId,
            s3_key: s3Key,
            error: err instanceof Error ? err.message : 'unknown',
        });
        return;
    }
    // ── Step 5: Update last_valid_config_version in DynamoDB ─────────────────
    await dynamo.send(new lib_dynamodb_1.UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
            pk: `TENANT#${tenantId}`,
            sk: `AGENT#${agentId}`,
        },
        UpdateExpression: 'SET last_valid_config_version = :v, config_rendered_at = :now',
        ExpressionAttributeValues: {
            ':v': configVersionAttempted,
            ':now': new Date().toISOString(),
        },
    }));
    // ── Step 6: Invoke bootstrapperLambda to copy S3 config to EFS ───────────
    try {
        await lambda.send(new client_lambda_1.InvokeCommand({
            FunctionName: BOOTSTRAPPER_ARN,
            InvocationType: 'RequestResponse', // sync: wait for EFS write before returning
            Payload: Buffer.from(JSON.stringify({ tenantId, agentId, s3Key })),
        }));
    }
    catch (err) {
        logger.error('Failed to invoke bootstrapperLambda', {
            tenant_id: tenantId,
            agent_id: agentId,
            error: err instanceof Error ? err.message : 'unknown',
        });
        return;
    }
    logger.info('Config rendered and deployed to EFS', {
        tenant_id: tenantId,
        agent_id: agentId,
        config_version: configVersionAttempted,
        s3_key: s3Key,
    });
};
exports.handler = handler;
function validateOpenClawConfig(config) {
    const errors = [];
    // Locked field verification — these must never change
    if (config.gateway.bind !== 'lan') {
        errors.push({ field: 'gateway.bind', error: 'LOCKED_FIELD_MODIFIED', allowed: 'lan' });
    }
    if (config.gateway.auth.mode !== 'trusted-proxy') {
        errors.push({ field: 'gateway.auth.mode', error: 'LOCKED_FIELD_MODIFIED', allowed: 'trusted-proxy' });
    }
    if (config.gateway.auth.trustedProxy.userHeader !== 'x-amzn-oidc-identity') {
        errors.push({ field: 'gateway.auth.trustedProxy.userHeader', error: 'LOCKED_FIELD_MODIFIED' });
    }
    if (config.agents.defaults.heartbeat.every !== '1h') {
        errors.push({ field: 'agents.defaults.heartbeat.every', error: 'LOCKED_FIELD_MODIFIED', allowed: '1h' });
    }
    if (config.agents.defaults.heartbeat.target !== 'none') {
        errors.push({ field: 'agents.defaults.heartbeat.target', error: 'LOCKED_FIELD_MODIFIED', allowed: 'none' });
    }
    if (config.agents.defaults.sandbox.mode !== 'off') {
        errors.push({ field: 'agents.defaults.sandbox.mode', error: 'LOCKED_FIELD_MODIFIED', allowed: 'off' });
    }
    // Tenant value structural validation
    if (config.agents.defaults.model?.primary) {
        const model = config.agents.defaults.model.primary;
        if (!model.includes('/')) {
            errors.push({ field: 'agents.defaults.model.primary', error: 'INVALID_FORMAT', allowed: 'provider/model' });
        }
    }
    if (config.agents.defaults.temperature !== undefined) {
        const t = config.agents.defaults.temperature;
        if (t < 0 || t > 1) {
            errors.push({ field: 'agents.defaults.temperature', error: 'OUT_OF_RANGE', allowed: '0.0-1.0' });
        }
    }
    if (config.agents.defaults.maxTokens !== undefined) {
        const mt = config.agents.defaults.maxTokens;
        if (mt < 256 || !Number.isInteger(mt)) {
            errors.push({ field: 'agents.defaults.maxTokens', error: 'BELOW_MINIMUM', allowed: '>= 256' });
        }
    }
    if (config.agents.defaults.session?.reset?.mode) {
        const valid = ['daily', 'idle', 'never'];
        if (!valid.includes(config.agents.defaults.session.reset.mode)) {
            errors.push({ field: 'agents.defaults.session.reset.mode', error: 'INVALID_ENUM_VALUE', allowed: valid });
        }
    }
    return errors;
}
