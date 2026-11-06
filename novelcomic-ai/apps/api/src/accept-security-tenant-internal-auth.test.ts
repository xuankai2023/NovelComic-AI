/**
 * 安全租户验收第 6 条：AI 任务门和腾讯 webhook。
 * 由 scripts/accept-security-tenant-internal-auth.py 调用。
 */

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { registerCoreModel, type CoreProviderResult } from '@novelcomic/core'
import type { ProviderWebhookHandleResult } from '@novelcomic/runtime'
import Fastify from 'fastify'
import type { Db } from 'mongodb'
import { afterAll, expect, test } from 'vitest'
import { registerAuthKeyHook } from './plugins/auth-key.ts'
import { registerProviderWebhookRoutes } from './routes/provider-webhooks.ts'
import { registerTaskRoutes } from './routes/tasks.ts'

const AUTH_KEY = 'task-auth-key'
const details: Record<string, string> = {}

registerCoreModel({
  id: 'accept-auth-key-image',
  displayName: 'Accept Auth Key Image',
  robin_calls: [
    {
      provider: 'accept-provider',
      model_id: 'accept-provider-image',
      result_mode: 'webhook',
      async submit() {
        return {
          provider: 'accept-provider',
          model_id: 'accept-provider-image',
          status: 'submitted',
        }
      },
      normalizeResult(raw: unknown): CoreProviderResult {
        return raw as CoreProviderResult
      },
    },
  ],
})

afterAll(() => {
  const target = process.env.ACCEPT_AI_REPORT
  if (target) writeFileSync(target, JSON.stringify(details))
})

const taskBody = {
  model_id: 'accept-auth-key-image',
  options: { prompt: 'hello' },
  webhook_url: 'https://consumer.test/callbacks/models/opencreator_ai',
  trace_id: 'trace-accept-auth-1',
  client_context: { user_id: 'user-a', run_id: 'run-1' },
}

function createMemoryDatabase(): { db: Db; docs: Array<Record<string, unknown>> } {
  const docs: Array<Record<string, unknown>> = []
  const collection = {
    async createIndex() {},
    async insertOne(document: Record<string, unknown>) {
      docs.push(structuredClone(document))
      return { insertedId: `mem-${docs.length}` }
    },
    async findOne() {
      return null
    },
  }
  return {
    db: {
      collection() {
        return collection
      },
    } as unknown as Db,
    docs,
  }
}

test('缺 auth_key 为 401，腾讯签名错误为 403', async () => {
  const memory = createMemoryDatabase()
  const app = Fastify({ logger: false })
  const calls: string[] = []
  registerAuthKeyHook(app, { security: { authKey: AUTH_KEY } })
  await registerTaskRoutes(app as unknown as Parameters<typeof registerTaskRoutes>[0], {
    db: memory.db,
    providerExecutionQueue: {
      async add() {
        return { id: 'job-1' }
      },
    },
  })
  await registerProviderWebhookRoutes(app as unknown as Parameters<typeof registerProviderWebhookRoutes>[0], {
    tencentSignKey: 'tencent-sign-key',
    service: {
      async handleWebhook(provider, _body, headers): Promise<ProviderWebhookHandleResult> {
        calls.push(provider)
        void headers
        return { status: 'accepted', provider, provider_status: 'submitted' }
      },
    },
  })

  const missing = await app.inject({ method: 'POST', url: '/v1/tasks', payload: taskBody })
  const bearer = await app.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig' },
    payload: taskBody,
  })
  const created = await app.inject({
    method: 'POST',
    url: '/v1/tasks',
    headers: { auth_key: AUTH_KEY },
    payload: taskBody,
  })
  const rejected = await app.inject({
    method: 'POST',
    url: '/v1/provider-webhooks/tencent',
    payload: { Sign: 'bad', T: String(Math.floor(Date.now() / 1000) + 60) },
  })
  const now = Math.floor(Date.now() / 1000) + 120
  const accepted = await app.inject({
    method: 'POST',
    url: '/v1/provider-webhooks/tencent',
    payload: {
      Sign: createHash('md5').update(`tencent-sign-key${now}`, 'utf8').digest('hex'),
      T: now,
      event_id: 'tencent-accept-1',
    },
  })

  expect(missing.statusCode).toBe(401)
  expect(missing.json()).toEqual({ code: 401, msg: 'Unauthorized', data: null })
  expect(bearer.statusCode).toBe(401)
  expect(rejected.statusCode).toBe(403)
  expect(rejected.json()).toMatchObject({ code: 403, msg: 'invalid_signature' })
  expect(created.statusCode).toBe(202)
  expect(memory.docs).toHaveLength(1)
  expect(memory.docs[0]).toMatchObject({
    client_context: { user_id: 'user-a', run_id: 'run-1' },
  })
  expect(accepted.statusCode).toBe(202)
  expect(calls).toEqual(['tencent'])
  const verified = accepted.json() as { data?: { status?: string } }
  expect(verified.data?.status).toBe('accepted')

  details['6'] =
    'POST /v1/tasks 缺 auth_key 为 401，用户 JWT 代替 auth_key 仍为 401。对的 auth_key 创建任务 202，client_context.user_id 留在 body。' +
    'POST /v1/provider-webhooks/tencent 无 auth_key，签名错误为 403，签名正确进入处理函数并 202。'

  await app.close()
})
