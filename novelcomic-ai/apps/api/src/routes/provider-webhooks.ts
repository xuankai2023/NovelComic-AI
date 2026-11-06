import { config } from '@novelcomic/config';
import { ProviderEventRepository, TaskRepository } from '@novelcomic/db';
import { verifyTencentWebhookSignature } from '@novelcomic/core';
import { ProviderWebhookService, type ProviderWebhookHandler, type ProviderWebhookHeaders, type ProviderWebhookQueue } from '@novelcomic/runtime';
import type { Db } from 'mongodb';
import type { logger as apiLogger } from '@novelcomic/observability';
import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';

type ApiFastifyInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  typeof apiLogger
>;

export interface RegisterProviderWebhookRoutesOptions {
  service?: ProviderWebhookHandler;
  tencentSignKey?: string;
  db?: Db;
  providerExecutionQueue?: ProviderWebhookQueue;
  artifactProcessingQueue?: ProviderWebhookQueue;
}

export async function registerProviderWebhookRoutes(
  app: ApiFastifyInstance,
  options: RegisterProviderWebhookRoutesOptions = {},
): Promise<void> {
  const service = options.service ?? createDefaultProviderWebhookService(options);
  const tencentSignKey = options.tencentSignKey ?? config.TENCENT_WEBHOOK_SIGN_KEY ?? '';

  app.post('/v1/provider-webhooks/:provider', async (request, reply) => {
    const provider = normalizeProviderParam((request.params as { provider?: string }).provider);
    if (!provider) {
      return reply.code(400).send({
        code: 400,
        msg: 'provider is required',
        data: null,
      });
    }

    const headers = normalizeHeaders(request.headers);
    delete headers['x-oc-signature-verified'];

    if (provider === 'tencent') {
      const verdict = verifyTencentWebhookSignature(coerceTencentBody(request.body), tencentSignKey);
      if (!verdict.valid) {
        return reply.code(403).send({
          code: 403,
          msg: 'invalid_signature',
          data: { status: 'rejected', reason: verdict.reason ?? 'invalid signature' },
        });
      }
      if (!verdict.reason) {
        headers['x-oc-signature-verified'] = 'true';
      }
    }

    if (provider === 'minimax') {
      const challenge = extractMinimaxChallenge(request.body);
      if (challenge !== undefined) {
        return reply.code(200).send({ challenge });
      }
    }

    const webhookBody = provider === 'minimax' ? flattenMinimaxWebhookBody(request.body) : request.body;
    const result = await service.handleWebhook(provider, webhookBody, headers);
    return reply.code(202).send({
      code: 200,
      msg: 'accepted',
      data: {
        status: result.status,
        provider: result.provider,
        ...(result.provider_status ? { provider_status: result.provider_status } : {}),
      },
    });
  });
}

function createDefaultProviderWebhookService(options: RegisterProviderWebhookRoutesOptions): ProviderWebhookHandler {
  if (!options.db) {
    throw new Error('provider webhook service requires a database');
  }
  const serviceOptions = {
    taskRepository: new TaskRepository(options.db),
    providerEventRepository: new ProviderEventRepository(options.db),
    ...(options.providerExecutionQueue ? { providerExecutionQueue: options.providerExecutionQueue } : {}),
    ...(options.artifactProcessingQueue ? { artifactProcessingQueue: options.artifactProcessingQueue } : {}),
  };
  return new ProviderWebhookService(serviceOptions);
}

function extractMinimaxChallenge(body: unknown): string | undefined {
  const record = coerceJsonRecord(body);
  const challenge = record?.challenge;
  return typeof challenge === 'string' && challenge.length > 0 ? challenge : undefined;
}

function flattenMinimaxWebhookBody(body: unknown): unknown {
  const record = coerceJsonRecord(body);
  if (!record) {
    return body;
  }
  const task = isRecord(record.task) ? record.task : undefined;
  if (!task) {
    return body;
  }
  return {
    ...record,
    ...(typeof task.id === 'string' || typeof task.id === 'number' ? { task_id: String(task.id) } : {}),
    ...(typeof task.status === 'string' ? { status: task.status } : {}),
    task,
  };
}

function coerceTencentBody(body: unknown): unknown {
  if (typeof body !== 'string') {
    return body;
  }
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return body;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return body;
  }
}

function coerceJsonRecord(body: unknown): Record<string, unknown> | undefined {
  const parsed = coerceTencentBody(body);
  return isRecord(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeProviderParam(provider: string | undefined): string {
  return provider?.trim().toLowerCase() ?? '';
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): ProviderWebhookHeaders {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(',') : value,
    ]),
  );
}
