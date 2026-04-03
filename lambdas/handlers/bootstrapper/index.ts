import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../layer/src/logger';

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

const logger = createLogger('bootstrapperLambda');

const s3 = new S3Client({});

const CONFIG_BUCKET = process.env.CONFIG_BUCKET!;
const EFS_MOUNT     = process.env.EFS_MOUNT ?? '/mnt/efs'; // Lambda EFS mount point

export const handler = async (event: {
  tenantId: string;
  agentId:  string;
  s3Key:    string;
}): Promise<{ success: boolean }> => {

  const { tenantId, agentId, s3Key } = event;

  if (!tenantId || !agentId || !s3Key) {
    logger.error('Missing required fields', { event });
    return { success: false };
  }

  // Download validated openclaw.json from S3
  let configContent: string;
  try {
    const s3Result = await s3.send(new GetObjectCommand({
      Bucket: CONFIG_BUCKET,
      Key:    s3Key,
    }));

    configContent = await s3Result.Body!.transformToString('utf-8');
  } catch (err) {
    logger.error('Failed to read config from S3', {
      tenant_id: tenantId,
      agent_id:  agentId,
      s3_key:    s3Key,
      error:     err instanceof Error ? err.message : 'unknown',
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
  const configDir  = path.dirname(configPath);

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
      tenant_id:   tenantId,
      agent_id:    agentId,
      efs_path:    configPath,
      config_size: configContent.length,
    });

    // Also create workspace directory if it doesn't exist
    // OpenClaw needs this directory to exist on first start
    const workspacePath = path.join(EFS_MOUNT, 'workspace');
    if (!fs.existsSync(workspacePath)) {
      fs.mkdirSync(workspacePath, { recursive: true });
      logger.info('Created workspace directory', {
        tenant_id: tenantId,
        agent_id:  agentId,
        path:      workspacePath,
      });
    }

    return { success: true };

  } catch (err) {
    logger.error('Failed to write config to EFS', {
      tenant_id:  tenantId,
      agent_id:   agentId,
      efs_path:   configPath,
      error:      err instanceof Error ? err.message : 'unknown',
    });
    return { success: false };
  }
};
