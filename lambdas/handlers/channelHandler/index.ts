import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { createLogger } from '../../layer/src/logger';
import { ok, badRequest, forbidden, notFound, parseBody } from '../../layer/src/response';

// ─────────────────────────────────────────────────────────────────────────────
// channelHandler
//
// PUT    /agents/{agentId}/channels         - Configure channel integrations
// DELETE /agents/{agentId}/channels/{name}  - Remove a channel integration
//
// Channels: discord, telegram, whatsapp (Pro+ only)
//
// Credentials are stored directly in DynamoDB as config fields
// (configHandler/configRenderer handles the secure flow to EFS).
// Channel tokens are write-only — masked on GET /config.
// ─────────────────────────────────────────────────────────────────────────────

const logger = createLogger('channelHandler');
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

const TABLE_NAME          = process.env.TABLE_NAME!;
const CONFIG_RENDERER_ARN = process.env.CONFIG_RENDERER_ARN!;

const SUPPORTED_CHANNELS = ['discord', 'telegram', 'whatsapp'];

interface ChannelConfig {
  discord?: {
    botToken: string;
    guildId?: string;
  };
  telegram?: {
    botToken: string;
  };
  whatsapp?: {
    phoneNumberId: string;
    accessToken:   string;
  };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const tenantId     = event.requestContext.authorizer?.claims?.['custom:tenant_id'] as string;
  const planCode      = event.requestContext.authorizer?.claims?.['custom:plan_code'] as string ?? 'starter';
  const agentId      = event.pathParameters?.agentId;
  const channelName  = event.pathParameters?.channelName;

  if (!tenantId || !agentId) return badRequest('Missing tenant or agent context');

  // Verify agent belongs to tenant
  const agentResult = await dynamo.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
  }));

  if (!agentResult.Item || agentResult.Item.tenant_id !== tenantId) {
    return notFound('Agent');
  }

  // ── PUT /channels — configure one or more channels ────────────────────
  if (event.httpMethod === 'PUT') {
    const body = parseBody<ChannelConfig>(event.body);
    if (!body) return badRequest('Invalid request body');

    const updateParts: string[] = ['updated_at = :now'];
    const updateValues: Record<string, unknown> = { ':now': new Date().toISOString() };
    const updateNames:  Record<string, string>  = {};

    // Discord
    if (body.discord !== undefined) {
      if (!body.discord.botToken || body.discord.botToken.length < 10) {
        return badRequest('Discord botToken is required and must be valid');
      }
      updateParts.push('#discordToken = :discordToken');
      updateNames['#discordToken'] = 'config_discordBotToken';
      updateValues[':discordToken'] = body.discord.botToken;

      if (body.discord.guildId) {
        updateParts.push('config_discordGuildId = :discordGuild');
        updateValues[':discordGuild'] = body.discord.guildId;
      }
    }

    // Telegram
    if (body.telegram !== undefined) {
      if (!body.telegram.botToken || body.telegram.botToken.length < 10) {
        return badRequest('Telegram botToken is required and must be valid');
      }
      updateParts.push('#telegramToken = :telegramToken');
      updateNames['#telegramToken'] = 'config_telegramBotToken';
      updateValues[':telegramToken'] = body.telegram.botToken;
    }

    // WhatsApp — Pro+ only
    if (body.whatsapp !== undefined) {
      if (!['pro', 'business'].includes(planCode)) {
        return {
          statusCode: 402,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error:   'PLAN_REQUIRED',
            message: 'WhatsApp integration requires Pro or Business plan.',
          }),
        };
      }
      if (!body.whatsapp.phoneNumberId || !body.whatsapp.accessToken) {
        return badRequest('WhatsApp requires phoneNumberId and accessToken');
      }
      updateParts.push('config_whatsappPhoneNumberId = :waPhone, config_whatsappAccessToken = :waToken');
      updateValues[':waPhone'] = body.whatsapp.phoneNumberId;
      updateValues[':waToken'] = body.whatsapp.accessToken;
    }

    if (updateParts.length === 1) {
      return badRequest('No channel configuration provided');
    }

    await dynamo.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
      UpdateExpression:          `SET ${updateParts.join(', ')}`,
      ExpressionAttributeNames:  Object.keys(updateNames).length ? updateNames : undefined,
      ExpressionAttributeValues: updateValues,
    }));

    // Trigger config re-render
    await lambda.send(new InvokeCommand({
      FunctionName:   CONFIG_RENDERER_ARN,
      InvocationType: 'Event',
      Payload:        Buffer.from(JSON.stringify({ tenantId, agentId })),
    }));

    logger.info('Channel credentials updated', {
      tenant_id: tenantId,
      agent_id:  agentId,
      channels:  Object.keys(body),
    });

    return ok({
      message:  'Channel configuration saved. Your agent will connect to the configured channels within a few seconds.',
      channels: Object.keys(body).filter(k => body[k as keyof ChannelConfig] !== undefined),
    });
  }

  // ── DELETE /channels/{channelName} ────────────────────────────────────
  if (event.httpMethod === 'DELETE' && channelName) {
    if (!SUPPORTED_CHANNELS.includes(channelName)) {
      return badRequest(`Unsupported channel. Supported: ${SUPPORTED_CHANNELS.join(', ')}`);
    }

    const removeAttrs: string[] = [];
    if (channelName === 'discord') {
      removeAttrs.push('config_discordBotToken', 'config_discordGuildId');
    } else if (channelName === 'telegram') {
      removeAttrs.push('config_telegramBotToken');
    } else if (channelName === 'whatsapp') {
      removeAttrs.push('config_whatsappPhoneNumberId', 'config_whatsappAccessToken');
    }

    await dynamo.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: `TENANT#${tenantId}`, sk: `AGENT#${agentId}` },
      UpdateExpression: `REMOVE ${removeAttrs.join(', ')} SET updated_at = :now`,
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    }));

    // Trigger config re-render to remove channel from openclaw.json
    await lambda.send(new InvokeCommand({
      FunctionName:   CONFIG_RENDERER_ARN,
      InvocationType: 'Event',
      Payload:        Buffer.from(JSON.stringify({ tenantId, agentId })),
    }));

    logger.info('Channel removed', { tenant_id: tenantId, agent_id: agentId, channel: channelName });
    return ok({ message: `${channelName} integration removed` });
  }

  return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: 'Method not allowed' };
};
