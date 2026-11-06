import { registerCoreModel, type CoreProviderResult } from '@novelcomic/core';
import Fastify from 'fastify';
import type { Db } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { registerTaskRoutes } from '../routes/tasks.js';
import { registerAuthKeyHook } from './auth-key.js';

registerCoreModel({
  id: 'auth-key-image',
  displayName: 'Auth Key Image',
  robin_calls: [
    {
      provider: 'auth-provider',
      model_id: 'auth-provider-image',
      result_mode: 'webhook',
      async submit() {
        return {
          provider: 'auth-provider',
          model_id: 'auth-provider-image',
          status: 'submitted',
        };
      },
      normalizeResult(raw: unknown): CoreProviderResult {
        return raw as CoreProviderResult;
      },
    },
  ],
});

const AUTH_KEY = 'task-auth-key';

const taskBody = {
  model_id: 'auth-key-image',
  options: { prompt: 'hello' },
  webhook_url: 'https://consumer.test/callbacks/models/opencreator_ai',
  trace_id: 'trace-auth-1',
  client_context: { user_id: 'user-a', run_id: 'run-1' },
};

function createMemoryDatabase(): { db: Db; docs: Array<Record<string, unknown>> } {
  const docs: Array<Record<string, unknown>> = [];
  const collection = {
    async createIndex() {},
    async insertOne(document: Record<string, unknown>) {
      docs.push(structuredClone(document));
      return { insertedId: `mem-${docs.length}` };
    },
    async findOne() {
      return null;
    },
  };
  return {
    db: {
      collection() {
        return collection;
      },
    } as unknown as Db,
    docs,
  };
}

async function createApp(authKey = AUTH_KEY) {
  const memory = createMemoryDatabase();
  const app = Fastify({ logger: false });
  registerAuthKeyHook(app, { security: { authKey } });
  await registerTaskRoutes(app as unknown as Parameters<typeof registerTaskRoutes>[0], {
    db: memory.db,
    providerExecutionQueue: {
      async add() {
        return { id: 'job-1' };
      },
    },
  });
  app.post('/v1/provider-webhooks/tencent', async () => ({ status: 'webhook-reached' }));
  app.get('/health', async () => ({ status: 'ok' }));
  return { app, docs: memory.docs };
}

describe('registerAuthKeyHook', () => {
  it('rejects /v1/tasks when auth_key is missing, wrong, or replaced by a user JWT', async () => {
    const { app, docs } = await createApp();

    const missing = await app.inject({ method: 'POST', url: '/v1/tasks', payload: taskBody });
    const mismatch = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { auth_key: 'other-key' },
      payload: taskBody,
    });
    const bearer = await app.inject({
      method: 'POST',
      url: '/v1/tasks?replay=1',
      headers: { authorization: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.e30.signature' },
      payload: taskBody,
    });

    for (const response of [missing, mismatch, bearer]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ code: 401, msg: 'Unauthorized', data: null });
    }
    expect(docs).toHaveLength(0);
    await app.close();
  });

  it('rejects every /v1 request when AUTH_KEY is empty', async () => {
    const { app, docs } = await createApp('');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { auth_key: '' },
      payload: taskBody,
    });

    expect(response.statusCode).toBe(401);
    expect(docs).toHaveLength(0);
    await app.close();
  });

  it('creates a task when auth_key matches and leaves client_context.user_id in the body', async () => {
    const { app, docs } = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: { auth_key: AUTH_KEY, authorization: 'Bearer not-the-task-key' },
      payload: taskBody,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'queued' });
    expect(response.json().ai_task_id).toMatch(/^task_/);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      model_id: 'auth-key-image',
      options: { prompt: 'hello' },
      webhook_url: taskBody.webhook_url,
      trace_id: 'trace-auth-1',
      client_context: { user_id: 'user-a', run_id: 'run-1' },
    });
    expect(docs[0]).not.toHaveProperty('auth_key');
    await app.close();
  });

  it('lets provider webhooks and non-v1 routes through without auth_key', async () => {
    const { app } = await createApp();
    const webhook = await app.inject({
      method: 'POST',
      url: '/v1/provider-webhooks/tencent?challenge=1',
      payload: { event: 'ping' },
    });
    const health = await app.inject({ method: 'GET', url: '/health' });

    expect(webhook.statusCode).toBe(200);
    expect(webhook.json()).toEqual({ status: 'webhook-reached' });
    expect(health.statusCode).toBe(200);
    await app.close();
  });
});
