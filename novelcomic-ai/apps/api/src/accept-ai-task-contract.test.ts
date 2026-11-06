import { AI_TASK_STATUSES, AiTaskDocumentSchema, AiTaskStatusSchema } from '@novelcomic/contracts';
import { registerCoreModel, registerCoreModelOptionConstraints, type CoreProviderResult, type CoreSubmitResult } from '@novelcomic/core';
import { AI_TASK_COLLECTION_NAME, TaskRepository } from '@novelcomic/db';
import { ProviderWorkerProcessor, type ProviderExecutionJob, type TaskSubmitQueue } from '@novelcomic/runtime';
import Fastify from 'fastify';
import type { Db } from 'mongodb';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerTaskRoutes } from './routes/tasks.js';

const CONSUMER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../novelcomic-consumer',
);
const WEBHOOK_URL = 'http://127.0.0.1:8001/v1/ai/tasks/callback';

const WORKFLOW_ONLY_STATUSES = [
  'pending',
  'running',
  'waiting_for_selection',
  'cancel_requested',
  'completed',
  'killed',
  'success',
  'stopped',
  'idle',
  'ready',
  'select',
] as const;

const WORKFLOW_STATUS_VOCABULARY = new Set<string>([...WORKFLOW_ONLY_STATUSES, 'queued', 'failed']);

type CapturedJob = {
  name: string;
  data: ProviderExecutionJob;
  options?: { jobId?: string };
};

type ChainResult = {
  create: {
    http_status: number;
    ai_task_id: string;
    task_status: string;
    request_body: {
      model_id: string;
      options: Record<string, unknown>;
      webhook_url: string;
      trace_id: string;
      idempotency_key: string;
      locale: string;
      client_context: Record<string, unknown>;
    };
  };
  replay: {
    http_status: number;
    ai_task_id: string;
    task_status: string;
    existing: boolean;
  };
  invocation: {
    ai_task_id: string;
    trace_id: string;
    idempotency_key: string;
    client_context: Record<string, unknown>;
    run_id: string;
    node_id: string;
    flow_run_id: string;
    flow_task_id: string;
    result_id: string;
    provider_gateway_status: string;
    status: string;
  };
  invocation_count: number;
  node_status: string;
};

class DuplicateKeyError extends Error {
  readonly code = 11000;

  constructor(indexName: string) {
    super(`E11000 duplicate key error index: ${indexName}`);
    this.name = 'MongoServerError';
  }
}

class MemoryCollection {
  readonly docs: Array<Record<string, unknown> & { _id: string }> = [];
  private seq = 0;
  private readonly uniqueIndexes: Array<{ field: string; name: string; sparse: boolean }> = [];

  async createIndex(
    key: Record<string, 1>,
    options: { unique?: boolean; sparse?: boolean; name: string },
  ): Promise<void> {
    if (!options.unique) return;
    const field = Object.keys(key)[0];
    if (!field) return;
    this.uniqueIndexes.push({ field, name: options.name, sparse: options.sparse === true });
  }

  async insertOne(document: Record<string, unknown>): Promise<{ insertedId: string }> {
    const stored = structuredClone(document) as Record<string, unknown> & { _id: string };
    stored._id = `mem-${++this.seq}`;
    for (const index of this.uniqueIndexes) {
      const value = stored[index.field];
      if (index.sparse && value === undefined) continue;
      const duplicate = this.docs.some((doc) => doc[index.field] === value);
      if (duplicate) throw new DuplicateKeyError(index.name);
    }
    this.docs.push(stored);
    return { insertedId: stored._id };
  }

  async findOne(query: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const found = this.docs.find((doc) =>
      Object.entries(query).every(([key, value]) => doc[key] === value),
    );
    return found ? structuredClone(found) : null;
  }

  async updateOne(
    query: Record<string, unknown>,
    update: { $set?: Record<string, unknown> },
  ): Promise<{ matchedCount: number }> {
    const found = this.docs.find((doc) =>
      Object.entries(query).every(([key, value]) => doc[key] === value),
    );
    if (!found) return { matchedCount: 0 };
    Object.assign(found, update.$set ?? {});
    return { matchedCount: 1 };
  }
}

function createMemoryDatabase(): { db: Db; tasks: MemoryCollection } {
  const tasks = new MemoryCollection();
  const db = {
    collection(name: string) {
      if (name !== AI_TASK_COLLECTION_NAME) {
        throw new Error(`unexpected collection ${name}`);
      }
      return tasks;
    },
  };
  return { db: db as unknown as Db, tasks };
}

function runConsumerChain(baseUrl: string, resultPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'uv',
      ['run', 'pytest', 'tests/test_ai_task_contract_chain.py', '-q', '-s'],
      {
        cwd: CONSUMER_ROOT,
        env: {
          ...process.env,
          AI_TASK_BASE_URL: baseUrl,
          AI_TASK_CHAIN_RESULT: resultPath,
        },
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`consumer chain exited ${code ?? 'null'}\n${output}`));
    });
  });
}

describe.sequential('AI task contract acceptance chain', () => {
  const jobs: CapturedJob[] = [];
  const queue: TaskSubmitQueue = {
    async add(name, data, options) {
      const job: CapturedJob = { name, data: { ...data } };
      if (options) job.options = options;
      jobs.push(job);
      return { id: options?.jobId ?? name };
    },
  };
  const memory = createMemoryDatabase();
  let app: ReturnType<typeof Fastify> | undefined;
  let baseUrl = '';
  let resultDir = '';
  let chain: ChainResult | undefined;

  beforeAll(async () => {
    registerCoreModel({
      id: 'accept-image-v1',
      displayName: 'Accept Image',
      aliases: ['accept-image'],
      robin_calls: [
        {
          provider: 'accept-provider',
          model_id: 'accept-provider-image',
          options_schema: {
            type: 'object',
            required: ['execution_plans', 'inputs', 'node'],
            additionalProperties: false,
            properties: {
              execution_plans: { type: 'array' },
              inputs: { type: 'object' },
              node: { type: 'object' },
            },
          },
          result_mode: 'webhook',
          async submit(): Promise<CoreSubmitResult> {
            return {
              provider: 'accept-provider',
              model_id: 'accept-provider-image',
              provider_request_id: 'accept-provider-request-1',
              status: 'submitted',
            };
          },
          normalizeResult(raw: unknown): CoreProviderResult {
            return raw as CoreProviderResult;
          },
        },
      ],
    });
    registerCoreModelOptionConstraints('accept-image-v1', {
      strict: true,
      fields: {
        execution_plans: { type: 'array', required: true, itemType: 'object' },
        inputs: { type: 'object', required: true },
        node: { type: 'object', required: true },
      },
    });

    app = Fastify({ logger: false });
    await registerTaskRoutes(app as Parameters<typeof registerTaskRoutes>[0], {
      db: memory.db,
      providerExecutionQueue: queue,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('acceptance server did not bind a TCP port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    resultDir = await mkdtemp(path.join(tmpdir(), 'ai-task-chain-'));
  });

  afterAll(async () => {
    await app?.close();
    if (resultDir) await rm(resultDir, { recursive: true, force: true });
  });

  async function post(payload: unknown): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    if (!app) throw new Error('acceptance server is not started');
    const response = await app.inject({ method: 'POST', url: '/v1/tasks', payload });
    return { statusCode: response.statusCode, body: response.json() };
  }

  it(
    'rejects invalid bodies and models, then accepts one queued task through consumer replay and worker read',
    async () => {
      const schemaRejects = [
        { model_id: ' ', options: { execution_plans: [], inputs: {}, node: {} }, webhook_url: WEBHOOK_URL },
        { model_id: 'accept-image', options: [], webhook_url: WEBHOOK_URL },
        {
          model_id: 'accept-image',
          options: { execution_plans: [], inputs: {}, node: {} },
          webhook_url: WEBHOOK_URL,
          workflow_status: 'running',
        },
        { model_id: 'accept-image', options: { execution_plans: [], inputs: {}, node: {} }, webhook_url: 'not-a-url' },
      ];
      for (const payload of schemaRejects) {
        const rejected = await post(payload);
        expect(rejected.statusCode).toBe(400);
        expect(rejected.body.msg).toBe('Invalid request body');
        expect(rejected.body).not.toHaveProperty('ai_task_id');
      }

      const unknownModel = await post({
        model_id: 'missing-image-model',
        options: { execution_plans: [], inputs: {}, node: {} },
        webhook_url: WEBHOOK_URL,
      });
      expect(unknownModel.statusCode).toBe(400);
      expect(unknownModel.body.data).toMatchObject({ code: 'MODEL_NOT_REGISTERED' });

      const invalidOptions = await post({
        model_id: 'accept-image',
        options: { style: 'anime' },
        webhook_url: WEBHOOK_URL,
      });
      expect(invalidOptions.statusCode).toBe(400);
      expect(invalidOptions.body.data).toMatchObject({ code: 'MODEL_OPTIONS_INVALID' });
      expect(memory.tasks.docs).toHaveLength(0);
      expect(jobs).toHaveLength(0);

      const resultPath = path.join(resultDir, 'chain.json');
      await runConsumerChain(baseUrl, resultPath);
      chain = JSON.parse(await readFile(resultPath, 'utf8')) as ChainResult;

      expect(chain.create.http_status).toBe(202);
      expect(chain.create.task_status).toBe('queued');
      expect(chain.create.ai_task_id).toMatch(/^task_/);
      expect(memory.tasks.docs).toHaveLength(1);

      const repository = new TaskRepository(memory.db);
      const task = await repository.getById(chain.create.ai_task_id);
      expect(task).not.toBeNull();
      if (!task) return;
      expect(AiTaskDocumentSchema.parse(task)).toMatchObject({
        ai_task_id: chain.create.ai_task_id,
        status: 'queued',
        model_id: 'accept-image',
        core_model_id: 'accept-image-v1',
        options: chain.create.request_body.options,
        webhook_url: chain.create.request_body.webhook_url,
        trace_id: 'trace-accept-1',
        idempotency_key: 'result-accept-1',
        locale: 'zh',
        client_context: chain.create.request_body.client_context,
      });
      expect(Object.keys(task).sort()).toEqual(
        [
          'ai_task_id',
          'client_context',
          'core_model_id',
          'created_at',
          'idempotency_key',
          'locale',
          'model_id',
          'options',
          'status',
          'trace_id',
          'updated_at',
          'webhook_url',
        ].sort(),
      );

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.name).toBe('submit');
      expect(jobs[0]?.data).toEqual({ ai_task_id: chain.create.ai_task_id });
      expect(Object.keys(jobs[0]?.data ?? {})).toEqual(['ai_task_id']);
      expect(jobs[0]?.options).toEqual({ jobId: `provider-${chain.create.ai_task_id}` });

      expect(chain.replay).toEqual({
        http_status: 200,
        ai_task_id: chain.create.ai_task_id,
        task_status: 'existing',
        existing: true,
      });
      expect(jobs).toHaveLength(1);
      expect(memory.tasks.docs).toHaveLength(1);
      expect((await repository.getById(chain.create.ai_task_id))?.status).toBe('queued');

      expect(chain.invocation_count).toBe(1);
      expect(chain.invocation).toMatchObject({
        ai_task_id: chain.create.ai_task_id,
        trace_id: 'trace-accept-1',
        idempotency_key: 'result-accept-1',
        run_id: 'run-accept-1',
        node_id: 'node-accept-1',
        flow_run_id: 'run-accept-1',
        flow_task_id: 'flow-task-accept-1',
        result_id: 'result-accept-1',
        provider_gateway_status: 'queued',
        status: 'queued',
      });
      expect(chain.node_status).toBe('running');

      const invocationTask = await repository.getById(chain.invocation.ai_task_id);
      expect(invocationTask?.trace_id).toBe(chain.invocation.trace_id);
      expect(invocationTask?.client_context).toEqual(chain.invocation.client_context);
      expect(invocationTask?.options).toEqual(chain.create.request_body.options);
      expect(invocationTask?.webhook_url).toBe(chain.create.request_body.webhook_url);
      expect(invocationTask?.idempotency_key).toBe(chain.invocation.idempotency_key);
      expect(invocationTask?.model_id).toBe(chain.create.request_body.model_id);

      for (const status of WORKFLOW_ONLY_STATUSES) {
        expect(AiTaskStatusSchema.safeParse(status).success).toBe(false);
      }
      for (const status of AI_TASK_STATUSES) {
        if (status === 'queued' || status === 'failed') continue;
        expect(WORKFLOW_STATUS_VOCABULARY.has(status)).toBe(false);
      }
      expect(AiTaskDocumentSchema.safeParse({ ...task, status: 'running' }).success).toBe(false);
      expect(AiTaskDocumentSchema.safeParse({ ...task, status: 'success' }).success).toBe(false);
      expect(AiTaskDocumentSchema.safeParse({ ...task, node_status: 'running' }).success).toBe(false);
      expect(task.status).toBe('queued');
      expect(chain.node_status).not.toBe(task.status);

      const loaded = await new ProviderWorkerProcessor(repository).process({
        ai_task_id: chain.create.ai_task_id,
      });
      expect(loaded).toMatchObject({
        ai_task_id: task.ai_task_id,
        status: 'waiting_provider',
        model_id: task.model_id,
        options: task.options,
        webhook_url: task.webhook_url,
        client_context: task.client_context,
        provider: 'accept-provider',
        provider_model_id: 'accept-provider-image',
        provider_request_id: 'accept-provider-request-1',
        provider_status: 'submitted',
        result_mode: 'webhook',
        attempt: 1,
      });
      expect(loaded.result).toBeUndefined();
      expect((await repository.getById(task.ai_task_id))?.status).toBe('waiting_provider');
      expect(jobs).toHaveLength(1);
    },
    90_000,
  );

  it('keeps one task and one submit job when the same idempotency key is created concurrently', async () => {
    expect(chain).toBeDefined();
    if (!chain) return;
    const payload = {
      ...chain.create.request_body,
      idempotency_key: 'result-accept-concurrent',
      trace_id: 'trace-accept-concurrent',
    };
    const [left, right] = await Promise.all([post(payload), post(payload)]);
    const responses = [left, right].sort((a, b) => a.statusCode - b.statusCode);
    expect(responses.map((item) => item.statusCode)).toEqual([200, 202]);
    expect(responses[0]?.body).toMatchObject({
      ai_task_id: responses[1]?.body.ai_task_id,
      status: 'existing',
      existing: true,
    });
    expect(responses[1]?.body).toMatchObject({ status: 'queued' });

    const matches = memory.tasks.docs.filter((doc) => doc.idempotency_key === 'result-accept-concurrent');
    expect(matches).toHaveLength(1);
    const concurrentJobs = jobs.filter((job) => job.data.ai_task_id === responses[1]?.body.ai_task_id);
    expect(concurrentJobs).toHaveLength(1);
    expect(concurrentJobs[0]?.data).toEqual({ ai_task_id: responses[1]?.body.ai_task_id });
  });
});
