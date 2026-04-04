"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_s3_1 = require("@aws-sdk/client-s3");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("./logger");
// ─────────────────────────────────────────────────────────────────────────────
// bootstrapperLambda
//
// Internal Lambda — invoked sync by configRenderer after S3 write.
// Copies the validated openclaw.json from S3 to the tenant's EFS Access Point.
//
// This Lambda runs in the VPC with the EFS mount configured via environment.
// The EFS filesystem is mounted at /mnt/efs in this Lambda's execution environment.
// Each invocation writes to the tenant/agent-specific subdirectory via the
// EFS Access Point (POSIX uid=1000, root path /tenants/{tenantId}/agents/{agentId}/).
//
// The tenant's OpenClaw task reads openclaw.json from /home/node/.openclaw/openclaw.json
// which maps to the same EFS path via the task's EFS volume mount.
// ─────────────────────────────────────────────────────────────────────────────
const logger = (0, logger_1.createLogger)('bootstrapperLambda');
const s3 = new client_s3_1.S3Client({});
const CONFIG_BUCKET = process.env.CONFIG_BUCKET;
const EFS_MOUNT = process.env.EFS_MOUNT ?? '/mnt/efs'; // Lambda EFS mount point
const handler = async (event) => {
    const { tenantId, agentId, s3Key } = event;
    if (!tenantId || !agentId || !s3Key) {
        logger.error('Missing required fields', { event });
        return { success: false };
    }
    // Download validated openclaw.json from S3
    let configContent;
    try {
        const s3Result = await s3.send(new client_s3_1.GetObjectCommand({
            Bucket: CONFIG_BUCKET,
            Key: s3Key,
        }));
        configContent = await s3Result.Body.transformToString('utf-8');
    }
    catch (err) {
        logger.error('Failed to read config from S3', {
            tenant_id: tenantId,
            agent_id: agentId,
            s3_key: s3Key,
            error: err instanceof Error ? err.message : 'unknown',
        });
        return { success: false };
    }
    // Write to EFS at the path OpenClaw expects
    // EFS Access Point root: /tenants/{tenantId}/agents/{agentId}/
    // Lambda mounts EFS at EFS_MOUNT, so the full path is:
    //   {EFS_MOUNT}/openclaw.json
    // which maps to:
    //   /tenants/{tenantId}/agents/{agentId}/openclaw.json on EFS
    // which the OpenClaw container sees as:
    //   /home/node/.openclaw/openclaw.json (via EFS volume mount)
    const configPath = path.join(EFS_MOUNT, 'openclaw.json');
    const configDir = path.dirname(configPath);
    try {
        // Ensure directory exists (EFS Access Point creates the root, but subdirs may be needed)
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        // Write atomically: write to temp file then rename
        // Prevents OpenClaw from reading a partial config during hot-reload
        const tempPath = `${configPath}.tmp.${Date.now()}`;
        fs.writeFileSync(tempPath, configContent, { encoding: 'utf-8', mode: 0o644 });
        fs.renameSync(tempPath, configPath);
        logger.info('Config written to EFS', {
            tenant_id: tenantId,
            agent_id: agentId,
            efs_path: configPath,
            config_size: configContent.length,
        });
        // Also create workspace directory if it doesn't exist
        // OpenClaw needs this directory to exist on first start
        const workspacePath = path.join(EFS_MOUNT, 'workspace');
        if (!fs.existsSync(workspacePath)) {
            fs.mkdirSync(workspacePath, { recursive: true });
            logger.info('Created workspace directory', {
                tenant_id: tenantId,
                agent_id: agentId,
                path: workspacePath,
            });
        }
        return { success: true };
    }
    catch (err) {
        logger.error('Failed to write config to EFS', {
            tenant_id: tenantId,
            agent_id: agentId,
            efs_path: configPath,
            error: err instanceof Error ? err.message : 'unknown',
        });
        return { success: false };
    }
};
exports.handler = handler;
