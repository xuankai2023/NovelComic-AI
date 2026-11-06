/**
 * 观测验收里 AI 探活和飞书通知两条。
 * 由 scripts/accept-observability-health-slo.py 调用。
 */

import { writeFileSync } from 'node:fs'
import { afterAll, afterEach, expect, test, vi } from 'vitest'

import { registerHealthRoutes, type HealthRouteDependencies } from '../apps/api/src/routes/health.ts'
import { CallbackWorkerProcessor } from '../packages/runtime/src/callback-worker.ts'
import { FeishuWebhookClient } from '../packages/runtime/src/feishu-webhook-client.ts'
import { AlertFeishuNotifier } from '../packages/runtime/src/feishu-notifier.ts'
import { ModelCallNotifier } from '../packages/runtime/src/model-call-notifier.ts'

const details: Record<string, string> = {}

afterAll(() => {
  const target = process.env.ACCEPT_AI_REPORT
  if (target) writeFileSync(target, JSON.stringify(details))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

type Reply = {
  statusCode: number
  body: unknown
  code(statusCode: number): Reply
  send(payload: unknown): unknown
}

function mount(options: HealthRouteDependencies) {
  const routes = new Map<string, (request: unknown, reply: Reply) => Promise<unknown>>()
  registerHealthRoutes(
    {
      get(path, handler) {
        routes.set(path, handler)
      },
    },
    options,
  )
  return async (path: string) => {
    const reply: Reply = {
      statusCode: 200,
      body: undefined,
      code(statusCode: number) {
        this.statusCode = statusCode
        return this
      },
      send(payload: unknown) {
        this.body = payload
        return payload
      },
    }
    const result = await routes.get(path)?.({}, reply)
    return {
      statusCode: reply.statusCode,
      body: (result ?? reply.body) as Record<string, unknown>,
    }
  }
}

function mongo(ok: boolean): HealthRouteDependencies['mongo'] {
  return {
    db: {
      async command() {
        if (!ok) throw new Error('mongo down')
        return { ok: 1 }
      },
    },
  }
}

test('[13] Mongo 和 Redis 通、worker 心跳缺失时 /readyz 为 200', async () => {
  const keys: string[] = []
  const ready = mount({
    mongo: mongo(true),
    redis: {
      async ping() {
        return 'PONG'
      },
      async get(key: string) {
        keys.push(key)
        return null
      },
    },
  })
  const response = await ready('/readyz')
  expect(response.statusCode).toBe(200)
  expect(response.body).toMatchObject({
    status: 'ready',
    mongo: true,
    redis: true,
    worker_heartbeat: null,
  })
  expect(keys).toEqual(['novelcomic:readyz:worker:worker'])

  const mongoDown = await mount({
    mongo: mongo(false),
    redis: {
      async ping() {
        return 'PONG'
      },
      async get() {
        return null
      },
    },
  })('/readyz')
  expect(mongoDown.statusCode).toBe(503)
  expect(mongoDown.body.worker_heartbeat).toBeNull()
  expect(mongoDown.body.mongo).toBe(false)

  details['13'] =
    'Mongo 与 Redis 都通、心跳 key 为空时 /readyz=200，body.worker_heartbeat=null，读的是 novelcomic:readyz:worker:worker。Mongo 不通时 503，心跳字段仍在，不参与 ready。'
})

function task(aiTaskId: string) {
  return {
    ai_task_id: aiTaskId,
    status: 'succeeded' as const,
    model_id: 'model-1',
    core_model_id: 'core-1',
    options: {},
    webhook_url: 'https://example.com/webhook',
    created_at: new Date('2026-09-29T00:00:00.000Z'),
    updated_at: new Date('2026-09-29T00:00:01.000Z'),
  }
}

function repository(document: ReturnType<typeof task>) {
  const claimed = new Set<string>()
  const sent: string[] = []
  const failed: string[] = []
  return {
    sent,
    failed,
    document,
    async claimModelCallNotification(aiTaskId: string) {
      if (claimed.has(aiTaskId)) return false
      claimed.add(aiTaskId)
      return true
    },
    async markModelCallNotificationFailed(aiTaskId: string) {
      failed.push(aiTaskId)
    },
    async markModelCallNotificationSent(aiTaskId: string) {
      sent.push(aiTaskId)
    },
    async requireByAiTaskId() {
      return document
    },
  }
}

test('[14] 飞书 HTTP 失败或 code!=0 时，callback 终态和模型任务状态保持原路径', async () => {
  const warnings: string[] = []
  const failedTasks: string[] = []
  const dlq: Array<{ reason: string }> = []
  vi.stubGlobal('fetch', async () => new Response('down', { status: 502 }))
  const processor = new CallbackWorkerProcessor(
    {
      async deliver() {
        throw new Error('consumer still down')
      },
      async markFailed(aiTaskId: string) {
        failedTasks.push(aiTaskId)
      },
    },
    {
      async add(_name, data) {
        dlq.push({ reason: data.reason })
        return null
      },
    },
    { now: () => 5_000 },
    new AlertFeishuNotifier(
      {
        MODEL_CALL_FEISHU_ENVIRONMENT: 'accept',
        ALERT_FEISHU_ENABLED: true,
        ALERT_FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/bad',
        REASON_MAPPING_FEISHU_TIMEOUT_MS: 5_000,
      },
      new FeishuWebhookClient({
        enabled: true,
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/bad',
      }),
      {
        info() {
          return undefined
        },
        warn(_fields, message) {
          warnings.push(message)
        },
      },
    ),
  )

  await expect(
    processor.process({
      id: 'job-1',
      name: 'deliver',
      data: { ai_task_id: 'task-callback-1', enqueued_at: 1_000 },
      attemptsMade: 2,
      opts: { attempts: 3 },
      timestamp: 1_000,
    }),
  ).rejects.toThrow('consumer still down')
  expect(failedTasks).toEqual(['task-callback-1'])
  expect(dlq).toEqual([{ reason: 'consumer still down' }])
  expect(warnings).toEqual(['alert.feishu.callback_dlq_failed'])

  const httpTask = task('task-http')
  const httpRepo = repository(httpTask)
  vi.stubGlobal('fetch', async () => new Response('down', { status: 502 }))
  await expect(
    new ModelCallNotifier(
      {
        MODEL_CALL_FEISHU_ENABLED: true,
        MODEL_CALL_FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/model',
        MODEL_CALL_FEISHU_ENVIRONMENT: 'accept',
      },
      httpRepo,
      new FeishuWebhookClient({
        enabled: true,
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/model',
      }),
    ).notifyOnce('task-http'),
  ).rejects.toThrow(/status 502/)
  expect(httpTask.status).toBe('succeeded')
  expect(httpRepo.failed).toEqual(['task-http'])
  expect(httpRepo.sent).toEqual([])

  const codeTask = task('task-code')
  const codeRepo = repository(codeTask)
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ code: 9499, msg: 'rejected' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  await expect(
    new ModelCallNotifier(
      {
        MODEL_CALL_FEISHU_ENABLED: true,
        MODEL_CALL_FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/model',
        MODEL_CALL_FEISHU_ENVIRONMENT: 'accept',
      },
      codeRepo,
      new FeishuWebhookClient({
        enabled: true,
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/model',
      }),
    ).notifyOnce('task-code'),
  ).rejects.toThrow(/code=9499/)
  expect(codeTask.status).toBe('succeeded')
  expect(codeRepo.failed).toEqual(['task-code'])
  expect(codeRepo.sent).toEqual([])

  details['14'] =
    '飞书 HTTP 502 时 callback 仍 markFailed，DLQ reason 仍是 consumer still down，告警停在 alert.feishu.callback_dlq_failed。HTTP 502 和 body.code=9499 都只把模型通知标成 failed，任务 status 保持 succeeded。'
})
