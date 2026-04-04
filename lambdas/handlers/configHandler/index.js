"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const client_lambda_1 = require("@aws-sdk/client-lambda");
const logger_1 = require("../../layer/src/logger");
const response_1 = require("../../layer/src/response");
// ─────────────────────────────────────────────────────────────────────────────
// configHandler
//
// GET  /agents/{agentId}/config  - Return current config for the agent
// PUT  /agents/{agentId}/config  - Update allowed config fields
//
// Security model:
//   - Strict allowlist: ANY field not in ALLOWED_FIELDS returns 400 immediately
//   - Type and range validation per field
//   - Plan entitlement check (e.g. Ralph Loop only for Pro+)
//   - Tenant isolation: agent must belong to the requesting tenant
//   - On valid PUT: stores to DynamoDB, then async-invokes configRenderer
//
// IMPORTANT: This handler NEVER accepts raw openclaw.json.
//            It only accepts named fields from the allowlist below.
//            The configRenderer builds the actual openclaw.json from these fields.
// ─────────────────────────────────────────────────────────────────────────────
const logger = (0, logger_1.createLogger)('configHandler');
const dynamo = lib_dynamodb_1.DynamoDBDocumentClient.from(new client_dynamodb_1.DynamoDBClient({}));
const lambda = new client_lambda_1.LambdaClient({});
const TABLE_NAME = process.env.TABLE_NAME;
const CONFIG_RENDERER_ARN = process.env.CONFIG_RENDERER_ARN;
const ALLOWED_FIELDS = {
    systemPrompt: {
        type: 'string',
        dbKey: 'config_systemPrompt',
        validate: (v) => {
            if (typeof v !== 'string')
                return 'systemPrompt must be a string';
            if (v.length > 8000)
                return 'systemPrompt must be 8000 characters or fewer';
            return null;
        },
    },
    primaryModel: {
        type: 'string',
        dbKey: 'config_primaryModel',
        validate: (v) => {
            if (typeof v !== 'string')
                return 'primaryModel must be a string';
            if (!v.includes('/'))
                return 'primaryModel must be in provider/model format (e.g. anthropic/claude-haiku-4-5)';
            return null;
        },
    },
    temperature: {
        type: 'number',
        dbKey: 'config_temperature',
        validate: (v) => {
            if (typeof v !== 'number')
                return 'temperature must be a number';
            if (v < 0 || v > 1)
                return 'temperature must be between 0.0 and 1.0';
            return null;
        },
    },
    maxTokens: {
        type: 'number',
        dbKey: 'config_maxTokens',
        validate: (v) => {
            if (typeof v !== 'number' || !Number.isInteger(v))
                return 'maxTokens must be an integer';
            if (v < 256)
                return 'maxTokens must be at least 256';
            // No plan-tier ceiling — customer pays BYOK tokens directly
            // Model native ceiling enforced by the provider API
            return null;
        },
    },
    agentName: {
        type: 'string',
        dbKey: 'config_agentName',
        validate: (v) => {
            if (typeof v !== 'string')
                return 'agentName must be a string';
            if (v.length > 64)
                return 'agentName must be 64 characters or fewer';
            if (!/^[a-zA-Z0-9 _-]+$/.test(v))
                return 'agentName may only contain letters, numbers, spaces, hyphens, and underscores';
            return null;
        },
    },
    sessionResetMode: {
        type: 'enum',
        dbKey: 'config_sessionResetMode',
        validate: (v) => {
            const valid = ['daily', 'idle', 'never'];
            if (!valid.includes(v))
                return `sessionResetMode must be one of: ${valid.join(', ')}`;
            return null;
        },
    },
    sessionIdleMinutes: {
        type: 'number',
        dbKey: 'config_sessionIdleMinutes',
        validate: (v) => {
            if (typeof v !== 'number' || !Number.isInteger(v))
                return 'sessionIdleMinutes must be an integer';
            if (v < 30 || v > 480)
                return 'sessionIdleMinutes must be between 30 and 480';
            return null;
        },
    },
    discordBotToken: {
        type: 'string',
        dbKey: 'config_discordBotToken',
        validate: (v) => {
            if (typeof v !== 'string' || v.length < 10)
                return 'discordBotToken must be a non-empty string';
            return null;
        },
    },
    discordGuildId: {
        type: 'string',
        dbKey: 'config_discordGuildId',
        validate: (v) => {
            if (typeof v !== 'string')
                return 'discordGuildId must be a string';
            return null;
        },
    },
    telegramBotToken: {
        type: 'string',
        dbKey: 'config_telegramBotToken',
        validate: (v) => {
            if (typeof v !== 'string' || v.length < 10)
                return 'telegramBotToken must be a non-empty string';
            return null;
        },
    },
    whatsappPhoneNumberId: {
        type: 'string',
        dbKey: 'config_whatsappPhoneNumberId',
        planRequired: ['pro', 'business'],
        validate: (v) => {
            if (typeof v !== 'string')
                return 'whatsappPhoneNumberId must be a string';
            return null;
        },
    },
    whatsappAccessToken: {
        type: 'string',
        dbKey: 'config_whatsappAccessToken',
        planRequired: ['pro', 'business'],
        validate: (v) => {
            if (typeof v !== 'string' || v.length < 10)
                return 'whatsappAccessToken must be a non-empty string';
            return null;
        },
    },
    ralphLoopMaxIterations: {
        type: 'number',
        dbKey: 'config_ralphLoopMaxIterations',
        planRequired: ['pro', 'business'],
        validate: (v) => {
            if (typeof v !== 'number' || !Number.isInteger(v))
                return 'ralphLoopMaxIterations must be an integer';
            if (v < 1 || v > 50)
                return 'ralphLoopMaxIterations must be between 1 and 50';
            return null;
        },
    },
};
// ── Handler ────────────────────────────────────────────────────────────────
const handler = async (event) => {
    const tenantId = event.requestContext.authorizer?.tenantId;
    const planCode = event.requestContext.authorizer?.planCode;
    const agentId = event.pathParameters?.agentId;
    if (!tenantId || !agentId) {
        return (0, response_1.badRequest)('Missing tenantId or agentId');
    }
    const agentKey = {
        pk: `TENANT#${tenantId}`,
        sk: `AGENT#${agentId}`,
    };
    // Verify agent belongs to this tenant
    const agentResult = await dynamo.send(new lib_dynamodb_1.GetCommand({
        TableName: TABLE_NAME,
        Key: agentKey,
    }));
    if (!agentResult.Item) {
        return (0, response_1.notFound)('Agent');
    }
    if (agentResult.Item.tenant_id !== tenantId) {
        logger.warn('Cross-tenant agent access attempt', { tenant_id: tenantId, agent_id: agentId });
        return (0, response_1.forbidden)('Agent not found');
    }
    // ── GET ────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const configFields = {};
        for (const [fieldName, fieldDef] of Object.entries(ALLOWED_FIELDS)) {
            const dbValue = agentResult.Item[fieldDef.dbKey];
            if (dbValue !== undefined) {
                // Never return credential fields in GET response
                if (fieldName.toLowerCase().includes('token') ||
                    fieldName.toLowerCase().includes('accesstoken')) {
                    configFields[fieldName] = '••••••••'; // masked
                }
                else {
                    configFields[fieldName] = dbValue;
                }
            }
        }
        return (0, response_1.ok)({
            agentId,
            config: configFields,
            configVersion: agentResult.Item.config_version ?? 0,
            lastUpdated: agentResult.Item.config_updated_at,
        });
    }
    // ── PUT ────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'PUT') {
        const body = (0, response_1.parseBody)(event.body);
        if (!body || typeof body !== 'object') {
            return (0, response_1.badRequest)('Request body must be a JSON object');
        }
        // CRITICAL: Reject any field not in the allowlist
        const unknownFields = Object.keys(body).filter(k => !(k in ALLOWED_FIELDS));
        if (unknownFields.length > 0) {
            return (0, response_1.badRequest)(`Unknown config fields: ${unknownFields.join(', ')}. Only allowed fields may be configured.`, { allowedFields: Object.keys(ALLOWED_FIELDS) });
        }
        if (Object.keys(body).length === 0) {
            return (0, response_1.badRequest)('Request body must contain at least one field to update');
        }
        // Validate each field
        const validationErrors = [];
        for (const [fieldName, value] of Object.entries(body)) {
            const fieldDef = ALLOWED_FIELDS[fieldName];
            // Plan entitlement check
            if (fieldDef.planRequired && !fieldDef.planRequired.includes(planCode)) {
                validationErrors.push({
                    field: fieldName,
                    error: `${fieldName} requires plan: ${fieldDef.planRequired.join(' or ')}. Current plan: ${planCode}`,
                });
                continue;
            }
            // Type and range validation
            const error = fieldDef.validate(value, planCode);
            if (error) {
                validationErrors.push({ field: fieldName, error });
            }
        }
        if (validationErrors.length > 0) {
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: 'VALIDATION_FAILED',
                    message: 'One or more config fields failed validation',
                    validationErrors,
                }),
            };
        }
        // Build DynamoDB UpdateExpression — store each field individually
        const now = new Date().toISOString();
        const expressionParts = ['config_version = config_version + :inc', 'config_updated_at = :now'];
        const expressionValues = {
            ':inc': 1,
            ':now': now,
        };
        const expressionNames = {};
        for (const [fieldName, value] of Object.entries(body)) {
            const fieldDef = ALLOWED_FIELDS[fieldName];
            const attrName = `#${fieldName}`;
            expressionNames[attrName] = fieldDef.dbKey;
            expressionParts.push(`${attrName} = :${fieldName}`);
            expressionValues[`:${fieldName}`] = value;
        }
        await dynamo.send(new lib_dynamodb_1.UpdateCommand({
            TableName: TABLE_NAME,
            Key: agentKey,
            UpdateExpression: `SET ${expressionParts.join(', ')}`,
            ExpressionAttributeNames: expressionNames,
            ExpressionAttributeValues: expressionValues,
        }));
        // Async-invoke configRenderer to render and push new openclaw.json to EFS
        // Fire-and-forget: portal gets immediate 200, config renders in background (~2-3s)
        try {
            await lambda.send(new client_lambda_1.InvokeCommand({
                FunctionName: CONFIG_RENDERER_ARN,
                InvocationType: 'Event', // async
                Payload: Buffer.from(JSON.stringify({ tenantId, agentId })),
            }));
        }
        catch (err) {
            // Log but don't fail the PUT — config renderer has its own retry logic
            logger.error('Failed to invoke configRenderer async', {
                tenant_id: tenantId,
                agent_id: agentId,
                error: err instanceof Error ? err.message : 'unknown',
            });
        }
        logger.info('Config updated', {
            tenant_id: tenantId,
            agent_id: agentId,
            fields_updated: Object.keys(body),
        });
        return (0, response_1.ok)({
            message: 'Config updated. Changes will be applied to your agent within a few seconds.',
            agentId,
            fieldsUpdated: Object.keys(body),
        });
    }
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: 'Method not allowed' };
};
exports.handler = handler;
