"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const logger_1 = require("../../layer/src/logger");
const response_1 = require("../../layer/src/response");
// ─────────────────────────────────────────────────────────────────────────────
// fileHandler
//
// GET    /agents/{agentId}/files           - List workspace files
// POST   /agents/{agentId}/files           - Get presigned upload URL
// DELETE /agents/{agentId}/files/{fileKey} - Delete a file
// GET    /agents/{agentId}/files/{fileKey} - Get presigned download URL
//
// Files are stored in S3 (chat-history bucket, prefix: workspace/{tenantId}/{agentId}/)
// and synced to EFS workspace by bootstrapperLambda.
// Storage quota is enforced at the account level across all agents.
// ─────────────────────────────────────────────────────────────────────────────
const logger = (0, logger_1.createLogger)('fileHandler');
const s3 = new client_s3_1.S3Client({});
const dynamo = lib_dynamodb_1.DynamoDBDocumentClient.from(new client_dynamodb_1.DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME;
const CHAT_BUCKET = process.env.CHAT_BUCKET ?? `lavavps-chat-history-${process.env.AWS_ACCOUNT}`;
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB per file
const handler = async (event) => {
    const tenantId = event.requestContext.authorizer?.tenantId;
    const agentId = event.pathParameters?.agentId;
    const fileKey = event.pathParameters?.fileKey
        ? decodeURIComponent(event.pathParameters.fileKey)
        : undefined;
    if (!tenantId || !agentId)
        return (0, response_1.badRequest)('Missing tenant or agent context');
    // Verify agent belongs to tenant
    const agentResult = await dynamo.send(new lib_dynamodb_1.GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
    }));
    if (!agentResult.Item || agentResult.Item.tenant_id !== tenantId) {
        return (0, response_1.notFound)('Agent');
    }
    // Fetch tenant record for quota
    const tenantResult = await dynamo.send(new lib_dynamodb_1.GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `TENANT#${tenantId}`, sk: `TENANT#${tenantId}` },
    }));
    const storageQuotaGb = tenantResult.Item?.storage_quota_gb ?? 5;
    const storageUsedBytes = tenantResult.Item?.storage_used_bytes ?? 0;
    const storageQuotaBytes = storageQuotaGb * 1024 * 1024 * 1024;
    const s3Prefix = `workspace/${tenantId}/${agentId}/`;
    // ── GET /files — list workspace files ─────────────────────────────────
    if (event.httpMethod === 'GET' && !fileKey) {
        const listResult = await s3.send(new client_s3_1.ListObjectsV2Command({
            Bucket: CHAT_BUCKET,
            Prefix: s3Prefix,
        }));
        const files = (listResult.Contents ?? []).map(obj => ({
            key: obj.Key.replace(s3Prefix, ''),
            size: obj.Size ?? 0,
            lastModified: obj.LastModified?.toISOString(),
        }));
        return (0, response_1.ok)({
            files,
            storageQuotaGb,
            storageUsedGb: parseFloat((storageUsedBytes / 1024 / 1024 / 1024).toFixed(3)),
            storageUsedBytes,
            count: files.length,
        });
    }
    // ── GET /files/{fileKey} — presigned download URL ──────────────────────
    if (event.httpMethod === 'GET' && fileKey) {
        // Security: ensure fileKey doesn't escape the tenant prefix
        if (fileKey.includes('..') || fileKey.startsWith('/')) {
            return (0, response_1.badRequest)('Invalid file key');
        }
        const fullKey = `${s3Prefix}${fileKey}`;
        const url = await (0, s3_request_presigner_1.getSignedUrl)(s3, new client_s3_1.GetObjectCommand({
            Bucket: CHAT_BUCKET,
            Key: fullKey,
        }), { expiresIn: 300 }); // 5 minute download URL
        return (0, response_1.ok)({ downloadUrl: url, expiresIn: 300 });
    }
    // ── POST /files — get presigned upload URL ─────────────────────────────
    if (event.httpMethod === 'POST') {
        const body = (0, response_1.parseBody)(event.body);
        if (!body?.filename || !body?.size) {
            return (0, response_1.badRequest)('Request body must include filename and size');
        }
        if (body.filename.includes('..') || body.filename.startsWith('/')) {
            return (0, response_1.badRequest)('Invalid filename');
        }
        if (body.size > MAX_FILE_SIZE_BYTES) {
            return (0, response_1.badRequest)(`File size exceeds maximum of ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`);
        }
        // Quota check
        if (storageUsedBytes + body.size > storageQuotaBytes) {
            const usedGb = (storageUsedBytes / 1024 / 1024 / 1024).toFixed(2);
            const quotaGb = storageQuotaGb;
            return {
                statusCode: 413,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: 'QUOTA_EXCEEDED',
                    message: `Storage quota exceeded. Used: ${usedGb}GB / ${quotaGb}GB. Purchase additional storage to continue.`,
                    usedGb: parseFloat(usedGb),
                    quotaGb,
                }),
            };
        }
        const fullKey = `${s3Prefix}${body.filename}`;
        const uploadUrl = await (0, s3_request_presigner_1.getSignedUrl)(s3, new client_s3_1.PutObjectCommand({
            Bucket: CHAT_BUCKET,
            Key: fullKey,
            ContentType: body.contentType ?? 'application/octet-stream',
            ContentLength: body.size,
            Metadata: {
                'tenant-id': tenantId,
                'agent-id': agentId,
            },
        }), { expiresIn: 300 });
        // Update used bytes estimate (actual tracking via S3 event in Phase 8)
        await dynamo.send(new lib_dynamodb_1.UpdateCommand({
            TableName: TABLE_NAME,
            Key: { pk: `TENANT#${tenantId}`, sk: `TENANT#${tenantId}` },
            UpdateExpression: 'ADD storage_used_bytes :size',
            ExpressionAttributeValues: { ':size': body.size },
        }));
        return (0, response_1.ok)({ uploadUrl, key: body.filename, expiresIn: 300 });
    }
    // ── DELETE /files/{fileKey} ────────────────────────────────────────────
    if (event.httpMethod === 'DELETE' && fileKey) {
        if (fileKey.includes('..') || fileKey.startsWith('/')) {
            return (0, response_1.badRequest)('Invalid file key');
        }
        const fullKey = `${s3Prefix}${fileKey}`;
        // Get file size before deletion for quota update
        try {
            const headCmd = new client_s3_1.GetObjectCommand({ Bucket: CHAT_BUCKET, Key: fullKey });
            const head = await s3.send(headCmd);
            const size = head.ContentLength ?? 0;
            await s3.send(new client_s3_1.DeleteObjectCommand({ Bucket: CHAT_BUCKET, Key: fullKey }));
            // Decrease used bytes
            if (size > 0) {
                await dynamo.send(new lib_dynamodb_1.UpdateCommand({
                    TableName: TABLE_NAME,
                    Key: { pk: `TENANT#${tenantId}`, sk: `TENANT#${tenantId}` },
                    UpdateExpression: 'ADD storage_used_bytes :size',
                    ExpressionAttributeValues: { ':size': -size },
                }));
            }
        }
        catch (err) {
            const awsErr = err;
            if (awsErr.name === 'NoSuchKey')
                return (0, response_1.notFound)('File');
            throw err;
        }
        logger.info('File deleted', { tenant_id: tenantId, agent_id: agentId, file_key: fileKey });
        return (0, response_1.ok)({ message: 'File deleted', key: fileKey });
    }
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: 'Method not allowed' };
};
exports.handler = handler;
