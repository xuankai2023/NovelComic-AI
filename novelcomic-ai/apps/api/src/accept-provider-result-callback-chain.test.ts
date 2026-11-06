import type { AiTaskDocument, AiTaskStatus, JsonValue } from '@novelcomic/contracts';
import { registerCoreModel, type CoreProviderResult, type CoreSubmitResult } from '@novelcomic/core';
import {
  CallbackDeliveryRepository,
  ProviderEventRepository,
  TaskRepository,
} from '@novelcomic/db';
import {
  ArtifactWorkerProcessor,
  CallbackWorkerProcessor,
  ConsumerCallbackService,
  ProviderExecutionJobInvalidError,
  ProviderTaskNotFoundError,
  ProviderWebhookService,
  ProviderWorkerProcessor,
  createConsumerCallbackSignature,
  type ProviderExecutionJob,
} from '@novelcomic/runtime';
import { DefaultArtifactStore } from '@novelcomic/storage';
import Fastify from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { registerProviderWebhookRoutes } from './routes/provider-webhooks.js';

const CONSUMER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../novelcomic-consumer');
const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../novelcomic-frontend');
const CALLBACK_SECRET = 'chain-callback-secret';
const WEBHOOK_URL = 'https://consumer.test/callbacks/models/opencreator_ai';
const CDN_URL = 'https://cdn.test/chain-out.png';

const WEBHOOK_ID = 'task-chain-webhook';
const IMMEDIATE_ID = 'task-chain-immediate';
const POLL_OK_ID = 'task-chain-poll-ok';
const POLL_WAIT_ID = 'task-chain-poll-wait';
const POLL_FAIL_ID = 'task-chain-poll-fail';
const ROBIN_ID = 'task-chain-robin';
const FINAL_FAIL_ID = 'task-chain-final-fail';

type LoggedJob = {
  name: string;
  data: { ai_task_id: string; enqueued_at?: number; skip_providers?: string[] };
  options?: { jobId?: string };
};

type CapturedCallback = {
  rawBody: string;
  headers: Record<string, string>;
};

class DuplicateKeyError extends Error {
  readonly code = 11000;

  constructor() {
    super('E11000 duplicate key error');
    this.name = 'MongoServerError';
  }
}

class MemoryCollection {
  readonly docs: Array<Record<string, unknown> & { _id: string }> = [];
  private seq = 0;
  private readonly uniqueIndexes: Array<{ fields: string[]; sparse: boolean }> = [];

  async createIndex(
    key: Record<string, 1>,
    options: { unique?: boolean; sparse?: boolean; name: string },
  ): Promise<void> {
    if (!options.unique) return;
    this.uniqueIndexes.push({
      fields: Object.keys(key),
      sparse: options.sparse === true,
    });
  }

  async insertOne(document: Record<string, unknown>): Promise<{ insertedId: string }> {
    const stored = structuredClone(document) as Record<string, unknown> & { _id: string };
    stored._id = stored._id ?? `mem-${++this.seq}`;
    this.assertUnique(stored);
    this.docs.push(stored);
    return { insertedId: stored._id };
  }

  async findOne(query: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const found = this.docs.find((doc) => matches(doc, query));
    return found ? structuredClone(found) : null;
  }

  find(query: Record<string, unknown>) {
    const matched = this.docs.filter((doc) => matches(doc, query)).map((doc) => structuredClone(doc));
    const cursor = {
      sort(spec: Record<string, 1 | -1>) {
        const field = Object.keys(spec)[0];
        const direction = field ? spec[field] ?? 1 : 1;
        if (field) {
          matched.sort((left, right) => {
            if (left[field] === right[field]) return 0;
            return (left[field] > right[field] ? 1 : -1) * direction;
          });
        }
        return cursor;
      },
      async toArray() {
        return matched.map((doc) => structuredClone(doc));
      },
    };
    return cursor;
  }

  async updateOne(
    query: Record<string, unknown>,
    update: { $set?: Record<string, unknown> },
    options?: { upsert?: boolean },
  ): Promise<{ matchedCount: number }> {
    const found = this.docs.find((doc) => matches(doc, query));
    if (found) {
      Object.assign(found, structuredClone(update.$set ?? {}));
      return { matchedCount: 1 };
    }
    if (!options?.upsert) return { matchedCount: 0 };
    const created = {
      ...query,
      ...structuredClone(update.$set ?? {}),
      _id: `mem-${++this.seq}`,
    } as Record<string, unknown> & { _id: string };
    this.assertUnique(created);
    this.docs.push(created);
    return { matchedCount: 1 };
  }

  private assertUnique(document: Record<string, unknown>): void {
    for (const index of this.uniqueIndexes) {
      if (index.sparse && index.fields.some((field) => document[field] === undefined)) continue;
      const duplicate = this.docs.some((existing) =>
        index.fields.every((field) => existing[field] === document[field]),
      );
      if (duplicate) throw new DuplicateKeyError();
    }
  }
}

function matches(document: Record<string, unknown>, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([key, value]) => document[key] === value);
}

function createTask(overrides: Partial<AiTaskDocument> & Pick<AiTaskDocument, 'ai_task_id' | 'model_id' | 'core_model_id'>): AiTaskDocument {
  const now = new Date();
  return {
    status: 'queued',
    options: { prompt: 'chain' },
    webhook_url: WEBHOOK_URL,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function jobsFor(jobs: LoggedJob[], aiTaskId: string): LoggedJob[] {
  return jobs.filter((job) => job.data.ai_task_id === aiTaskId);
}

function waitForAbort(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    if (!signal) {
      reject(new Error('missing abort signal'));
      return;
    }
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

function runCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
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
      reject(new Error(`${command} ${args.join(' ')} exited ${code ?? 'null'}\n${output}`));
    });
  });
}

function registerChainModels(): void {
  const normalize = (raw: unknown): CoreProviderResult => {
    const body = raw as { status?: string; output?: string; artifact_url?: string; text?: string };
    if (body.status === 'failed') {
      return {
        status: 'failed',
        error: { code: 'provider_failed', message: 'provider failed', retryable: false },
      };
    }
    if (body.status === 'processing') return { status: 'processing' };
    const output = body.output ?? body.text ?? 'chain output';
    return {
      status: 'succeeded',
      outputs: body.artifact_url
        ? { output, artifacts: [{ type: 'image', url: body.artifact_url }] }
        : { output },
    };
  };

  registerCoreModel({
    id: 'chain-webhook',
    displayName: 'Chain Webhook',
    robin_calls: [
      {
        provider: 'provider-webhook',
        model_id: 'provider-webhook-model',
        result_mode: 'webhook',
        async submit(): Promise<CoreSubmitResult> {
          return {
            provider: 'provider-webhook',
            model_id: 'provider-webhook-model',
            provider_request_id: 'request-chain-webhook',
            status: 'submitted',
          };
        },
        normalizeResult: normalize,
      },
      {
        provider: 'provider-webhook-b',
        model_id: 'provider-webhook-b-model',
        result_mode: 'webhook',
        async submit(): Promise<CoreSubmitResult> {
          return {
            provider: 'provider-webhook-b',
            model_id: 'provider-webhook-b-model',
            provider_request_id: 'request-chain-webhook-b',
            status: 'submitted',
          };
        },
        normalizeResult: normalize,
      },
    ],
  });

  registerCoreModel({
    id: 'chain-immediate',
    displayName: 'Chain Immediate',
    robin_calls: [
      {
        provider: 'provider-sync',
        model_id: 'provider-sync-model',
        result_mode: 'sync',
        async submit(): Promise<CoreSubmitResult> {
          return {
            provider: 'provider-sync',
            model_id: 'provider-sync-model',
            provider_request_id: 'request-chain-immediate',
            status: 'succeeded',
            result_mode: 'sync',
            immediateResult: { text: 'immediate hello', artifact_url: 'https://vendor.test/immediate.png' },
          } as CoreSubmitResult;
        },
        normalizeResult: normalize,
      },
    ],
  });

  registerCoreModel({
    id: 'chain-poll-ok',
    displayName: 'Chain Poll Ok',
    robin_calls: [
      {
        provider: 'provider-poll',
        model_id: 'provider-poll-ok',
        result_mode: 'polling',
        async submit(): Promise<CoreSubmitResult> {
          return {
            provider: 'provider-poll',
            model_id: 'provider-poll-ok',
            provider_request_id: 'request-poll-ok',
            status: 'submitted',
            result_mode: 'polling',
          };
        },
        async getResult() {
          return { status: 'succeeded', output: 'polling done' };
        },
        normalizeResult: normalize,
      },
    ],
  });

  registerCoreModel({
    id: 'chain-poll-wait',
    displayName: 'Chain Poll Wait',
    robin_calls: [
      {
        provider: 'provider-poll',
        model_id: 'provider-poll-wait',
        result_mode: 'polling',
        async submit(): Promise<CoreSubmitResult> {
          return {
            provider: 'provider-poll',
            model_id: 'provider-poll-wait',
            provider_request_id: 'request-poll-wait',
            status: 'submitted',
            result_mode: 'polling',
          };
        },
        async getResult() {
          return { status: 'processing' };
        },
        normalizeResult: normalize,
      },
    ],
  });

  registerCoreModel({
    id: 'chain-poll-fail',
    displayName: 'Chain Poll Fail',
    robin_calls: [
      {
        provider: 'provider-poll',
        model_id: 'provider-poll-fail',
        result_mode: 'polling',
        async submit(): Promise<CoreSubmitResult> {
          return {
            provider: 'provider-poll',
            model_id: 'provider-poll-fail',
            provider_request_id: 'request-poll-fail',
            status: 'submitted',
            result_mode: 'polling',
          };
        },
        async getResult() {
          return { status: 'failed' };
        },
        normalizeResult: normalize,
      },
    ],
  });

  registerCoreModel({
    id: 'chain-robin',
    displayName: 'Chain Robin',
    robin_calls: [
      {
        provider: 'provider-a',
        model_id: 'provider-a-model',
        result_mode: 'webhook',
        async submit(): Promise<CoreSubmitResult> {
          throw new Error('provider-a unavailable');
        },
        normalizeResult: normalize,
      },
      {
        provider: 'provider-b',
        model_id: 'provider-b-model',
        result_mode: 'webhook',
        async submit(): Promise<CoreSubmitResult> {
          return {
            provider: 'provider-b',
            model_id: 'provider-b-model',
            provider_request_id: 'request-robin-b',
            status: 'submitted',
          };
        },
        normalizeResult: normalize,
      },
    ],
  });

  registerCoreModel({
    id: 'chain-final-fail',
    displayName: 'Chain Final Fail',
    robin_calls: [
      {
        provider: 'provider-only',
        model_id: 'provider-only-model',
        result_mode: 'webhook',
        async submit(): Promise<CoreSubmitResult> {
          throw new Error('provider down');
        },
        normalizeResult: normalize,
      },
    ],
  });
}

describe('provider result callback acceptance chain', () => {
  it(
    'runs submit, result convergence, artifacts, signed callback, consumer match, and workflow events',
    async () => {
      registerChainModels();
      const tasks = new MemoryCollection();
      const events = new MemoryCollection();
      const deliveries = new MemoryCollection();
      const taskRepository = new TaskRepository(tasks as never);
      const eventRepository = new ProviderEventRepository(events as never);
      const deliveryRepository = new CallbackDeliveryRepository(deliveries as never);
      await taskRepository.ensureIndexes();
      await eventRepository.ensureIndexes();
      await deliveryRepository.ensureIndexes();

      const loadedIds: string[] = [];
      const loadedTasks: AiTaskDocument[] = [];
      const submitted: AiTaskDocument[] = [];
      const statusChanges: Array<{ ai_task_id: string; status: string }> = [];
      const attempts: Array<{ ai_task_id: string; provider_request_id?: string; status: string }> = [];
      const originalRequire = taskRepository.requireByAiTaskId.bind(taskRepository);
      const originalSubmitted = taskRepository.markProviderSubmitted.bind(taskRepository);
      const originalStatus = taskRepository.updateStatus.bind(taskRepository);
      taskRepository.requireByAiTaskId = async (aiTaskId: string) => {
        loadedIds.push(aiTaskId);
        const task = await originalRequire(aiTaskId);
        loadedTasks.push(task);
        return task;
      };
      taskRepository.markProviderSubmitted = async (input) => {
        const updated = await originalSubmitted(input);
        submitted.push(updated);
        return updated;
      };
      taskRepository.updateStatus = async (aiTaskId: string, status: AiTaskStatus) => {
        statusChanges.push({ ai_task_id: aiTaskId, status });
        await originalStatus(aiTaskId, status);
      };

      const providerJobs: LoggedJob[] = [];
      const artifactJobs: LoggedJob[] = [];
      const callbackJobs: LoggedJob[] = [];
      const dlqJobs: LoggedJob[] = [];
      const pushJob = (bucket: LoggedJob[]) => async (
        name: string,
        data: LoggedJob['data'],
        options?: { jobId?: string },
      ) => {
        const job: LoggedJob = { name, data: { ...data } };
        if (options) job.options = options;
        bucket.push(job);
        return { id: options?.jobId ?? name };
      };

      const providerWorker = new ProviderWorkerProcessor(
        taskRepository,
        undefined,
        { add: pushJob(providerJobs) },
        {
          async upsertAttempt(input) {
            attempts.push({
              ai_task_id: input.ai_task_id,
              status: input.status,
              ...(input.provider_request_id ? { provider_request_id: input.provider_request_id } : {}),
            });
          },
        },
        { add: pushJob(artifactJobs) },
        { pollingTimeoutMs: 1_000 },
      );
      const webhookService = new ProviderWebhookService({
        taskRepository,
        providerEventRepository: eventRepository,
        providerExecutionQueue: { add: pushJob(providerJobs) },
        artifactProcessingQueue: { add: pushJob(artifactJobs) },
      });
      const processedResults: unknown[] = [];
      const artifactStore = new DefaultArtifactStore({
        async uploadRemoteUrl() {
          return CDN_URL;
        },
      });
      const artifactWorker = new ArtifactWorkerProcessor(
        {
          requireByAiTaskId: (aiTaskId) => taskRepository.requireByAiTaskId(aiTaskId),
          updateStatus: (aiTaskId, status) => taskRepository.updateStatus(aiTaskId, status as AiTaskStatus),
          updateResult: (aiTaskId, result) => taskRepository.updateResult(aiTaskId, result as JsonValue),
        },
        {
          async processResult(result) {
            processedResults.push(result);
            return artifactStore.processResult(result);
          },
        },
        { add: pushJob(callbackJobs) },
      );
      const captured = new Map<string, CapturedCallback>();
      const callbackAttempts = new Map<string, number>();
      const callbackService = new ConsumerCallbackService(
        taskRepository,
        {
          consumerWebhookSecret: CALLBACK_SECRET,
          requestTimeoutMs: 40,
          fetch: async (url, init) => {
            const rawBody = String(init?.body ?? '');
            const payload = JSON.parse(rawBody) as { ai_task_id: string };
            const attempt = (callbackAttempts.get(payload.ai_task_id) ?? 0) + 1;
            callbackAttempts.set(payload.ai_task_id, attempt);
            if (payload.ai_task_id === FINAL_FAIL_ID) {
              if (attempt === 2) await waitForAbort(init?.signal);
              return new Response('unavailable', { status: 503 });
            }
            captured.set(payload.ai_task_id, { rawBody, headers: headerRecord(init?.headers) });
            expect(url).toBe(WEBHOOK_URL);
            return new Response(JSON.stringify({ status: 'accepted' }), { status: 200 });
          },
        },
        deliveryRepository,
      );
      const callbackWorker = new CallbackWorkerProcessor(callbackService, { add: pushJob(dlqJobs) });
      const app = Fastify({ logger: false });
      await registerProviderWebhookRoutes(app as Parameters<typeof registerProviderWebhookRoutes>[0], {
        service: webhookService,
      });

      const resultDir = await mkdtemp(path.join(tmpdir(), 'provider-callback-chain-'));
      try {
        await tasks.insertOne(createTask({
          ai_task_id: WEBHOOK_ID,
          model_id: 'chain-webhook',
          core_model_id: 'chain-webhook',
          trace_id: 'trace-chain-webhook',
          client_context: {
            run_id: 'run-chain',
            node_id: 'model',
            result_id: 'result-chain',
            flow_run_id: 'run-chain',
            flow_task_id: 'flow-task-chain',
          },
        }));
        await tasks.insertOne(createTask({
          ai_task_id: IMMEDIATE_ID,
          model_id: 'chain-immediate',
          core_model_id: 'chain-immediate',
          trace_id: 'trace-chain-immediate',
          client_context: {
            run_id: 'run-context',
            node_id: 'model',
            result_id: 'result-context',
            flow_run_id: 'run-context',
            flow_task_id: 'flow-task-context',
          },
        }));
        for (const [aiTaskId, modelId] of [
          [POLL_OK_ID, 'chain-poll-ok'],
          [POLL_WAIT_ID, 'chain-poll-wait'],
          [POLL_FAIL_ID, 'chain-poll-fail'],
          [ROBIN_ID, 'chain-robin'],
          [FINAL_FAIL_ID, 'chain-final-fail'],
        ] as const) {
          await tasks.insertOne(createTask({
            ai_task_id: aiTaskId,
            model_id: modelId,
            core_model_id: modelId,
          }));
        }

        await expect(providerWorker.process({ ai_task_id: ' ' })).rejects.toBeInstanceOf(ProviderExecutionJobInvalidError);
        expect(loadedIds, '1. invalid submit job does not load a task').toEqual([]);
        await expect(providerWorker.process({ ai_task_id: 'missing-task' })).rejects.toBeInstanceOf(ProviderTaskNotFoundError);
        expect(loadedIds, '1. submit job reads ai_task_id and loads the task').toEqual(['missing-task']);

        const webhookTask = await providerWorker.process({ ai_task_id: WEBHOOK_ID });
        expect(loadedTasks.find((task) => task.ai_task_id === WEBHOOK_ID), '1. submit job loads the queued task').toMatchObject({
          ai_task_id: WEBHOOK_ID,
          status: 'queued',
          model_id: 'chain-webhook',
          options: { prompt: 'chain' },
          webhook_url: WEBHOOK_URL,
        });
        expect(webhookTask, '2. submit writes provider_request_id and waiting_provider').toMatchObject({
          status: 'waiting_provider',
          provider: 'provider-webhook',
          provider_model_id: 'provider-webhook-model',
          provider_request_id: 'request-chain-webhook',
        });
        expect(submitted.find((task) => task.ai_task_id === WEBHOOK_ID)?.status).toBe('waiting_provider');
        expect(attempts, '2. attempt records the provider request').toContainEqual({
          ai_task_id: WEBHOOK_ID,
          provider_request_id: 'request-chain-webhook',
          status: 'submitted',
        });

        const immediateTask = await providerWorker.process({ ai_task_id: IMMEDIATE_ID });
        expect(immediateTask.status, '3. immediate result applies before returning').toBe('processing_artifacts');
        expect(jobsFor(artifactJobs, IMMEDIATE_ID), '3. immediate result enters artifact-processing').toEqual([
          expect.objectContaining({ name: 'process', options: { jobId: `artifact-${IMMEDIATE_ID}` } }),
        ]);
        await artifactWorker.process(jobsFor(artifactJobs, IMMEDIATE_ID)[0]!.data);
        expect(await taskRepository.getById(IMMEDIATE_ID), '3. immediate artifacts become callback_pending').toMatchObject({
          status: 'callback_pending',
          result: { output: 'immediate hello', artifacts: [{ type: 'image', url: CDN_URL }] },
        });

        const pollOk = await providerWorker.process({ ai_task_id: POLL_OK_ID });
        expect(pollOk, '4. polling success normalizes into processing_artifacts').toMatchObject({
          status: 'processing_artifacts',
          provider_request_id: 'request-poll-ok',
          result: { output: 'polling done' },
        });
        expect(jobsFor(artifactJobs, POLL_OK_ID)).toHaveLength(1);
        const pollWait = await providerWorker.process({ ai_task_id: POLL_WAIT_ID });
        expect(pollWait.status, '4. polling still waiting stays waiting_provider').toBe('waiting_provider');
        expect(jobsFor(artifactJobs, POLL_WAIT_ID), '4. in-progress polling does not enter artifacts').toEqual([]);
        const pollFail = await providerWorker.process({ ai_task_id: POLL_FAIL_ID });
        expect(pollFail, '4. polling failure normalizes without another provider').toMatchObject({
          status: 'failed',
          error: { code: 'provider_failed', message: 'provider failed', retryable: false },
        });
        expect(jobsFor(artifactJobs, POLL_FAIL_ID)).toHaveLength(1);

        const staleBody = JSON.stringify({
          ai_task_id: WEBHOOK_ID,
          data: JSON.stringify({
            request_id: 'request-old-attempt',
            provider_model_id: 'provider-webhook-model',
            status: 'succeeded',
            event_id: 'evt-stale-attempt',
            attempt: 0,
            output: 'stale output',
          }),
        });
        const stale = await webhookService.handleWebhook('provider-webhook', staleBody, {
          'x-provider-signature': 'sig-stale',
        });
        expect(stale, '5. stale webhook is accepted without advancing the task').toMatchObject({
          status: 'accepted',
          provider: 'provider-webhook',
        });
        expect(jobsFor(artifactJobs, WEBHOOK_ID), '5. old attempt does not enter artifact-processing').toEqual([]);
        expect((await taskRepository.getById(WEBHOOK_ID))?.status).toBe('waiting_provider');
        expect((await taskRepository.getById(WEBHOOK_ID))?.result).toBeUndefined();

        const successPayload = {
          ai_task_id: WEBHOOK_ID,
          event_id: 'evt-chain-success',
          request_id: 'request-chain-webhook',
          provider_model_id: 'provider-webhook-model',
          status: 'succeeded',
          attempt: 1,
          output: 'chain output',
          artifact_url: 'https://vendor.test/chain.png',
        };
        const accepted = await app.inject({
          method: 'POST',
          url: '/v1/provider-webhooks/provider-webhook',
          payload: successPayload,
        });
        expect(accepted.statusCode).toBe(202);
        expect((await taskRepository.getById(WEBHOOK_ID))?.status).toBe('processing_artifacts');
        expect(jobsFor(artifactJobs, WEBHOOK_ID)).toHaveLength(1);
        const replay = await app.inject({
          method: 'POST',
          url: '/v1/provider-webhooks/provider-webhook',
          payload: successPayload,
        });
        expect(replay.statusCode).toBe(202);
        expect(jobsFor(artifactJobs, WEBHOOK_ID), '6. webhook replay does not enqueue artifacts again').toHaveLength(1);
        expect(events.docs.filter((doc) => doc.event_id === 'evt-chain-success')).toHaveLength(1);

        const robinBefore = jobsFor(providerJobs, ROBIN_ID).length;
        const robinFailed = await providerWorker.process({ ai_task_id: ROBIN_ID });
        expect(robinFailed, '7. robin failure keeps the task retryable').toMatchObject({
          status: 'queued',
          skip_providers: ['provider-a:provider-a-model'],
        });
        const robinFallback = jobsFor(providerJobs, ROBIN_ID).slice(robinBefore);
        expect(robinFallback, '7. robin enqueues the next provider').toEqual([
          expect.objectContaining({
            name: 'submit',
            data: { ai_task_id: ROBIN_ID, skip_providers: ['provider-a:provider-a-model'] },
            options: { jobId: `provider-${ROBIN_ID}-fallback-provider-b-provider-b-model` },
          }),
        ]);
        expect(jobsFor(artifactJobs, ROBIN_ID)).toEqual([]);
        const robinSubmitted = await providerWorker.process(robinFallback[0]!.data as ProviderExecutionJob);
        expect(robinSubmitted, '7. fallback submit writes the next provider request').toMatchObject({
          status: 'waiting_provider',
          provider: 'provider-b',
          provider_request_id: 'request-robin-b',
        });

        const processedBeforeFinal = processedResults.length;
        const finalFailed = await providerWorker.process({ ai_task_id: FINAL_FAIL_ID });
        expect(finalFailed, '7. no robin writes the final provider failure').toMatchObject({
          status: 'failed',
          error: { code: 'provider_submit_failed', message: 'provider down', retryable: false },
        });
        expect(jobsFor(providerJobs, FINAL_FAIL_ID), '7. no robin does not enqueue another submit').toEqual([]);
        expect(jobsFor(artifactJobs, FINAL_FAIL_ID)).toHaveLength(1);

        await artifactWorker.process(jobsFor(artifactJobs, WEBHOOK_ID)[0]!.data);
        expect(
          statusChanges.filter((item) => item.ai_task_id === WEBHOOK_ID).map((item) => item.status),
          '8. success walks processing_artifacts then callback_pending',
        ).toEqual(['processing_artifacts', 'callback_pending']);
        expect(await taskRepository.getById(WEBHOOK_ID)).toMatchObject({
          status: 'callback_pending',
          result: { output: 'chain output', artifacts: [{ type: 'image', url: CDN_URL }] },
        });
        expect(jobsFor(callbackJobs, WEBHOOK_ID)).toEqual([
          expect.objectContaining({ name: 'deliver', options: { jobId: `callback-${WEBHOOK_ID}` } }),
        ]);

        await artifactWorker.process(jobsFor(artifactJobs, POLL_FAIL_ID)[0]!.data);
        await artifactWorker.process(jobsFor(artifactJobs, FINAL_FAIL_ID)[0]!.data);
        expect(processedResults.length, '9. failed results skip artifact processing').toBe(processedBeforeFinal + 1);
        expect(
          statusChanges.filter((item) => item.ai_task_id === POLL_FAIL_ID).map((item) => item.status),
          '9. polling failure still enters callback_pending',
        ).toEqual(['callback_pending']);
        expect(
          statusChanges.filter((item) => item.ai_task_id === FINAL_FAIL_ID).map((item) => item.status),
        ).toEqual(['callback_pending']);

        await callbackWorker.process({
          name: 'deliver',
          data: jobsFor(callbackJobs, WEBHOOK_ID)[0]!.data as { ai_task_id: string; enqueued_at: number },
          attemptsMade: 0,
          opts: { attempts: 3 },
          timestamp: Date.now(),
        });
        await callbackWorker.process({
          name: 'deliver',
          data: jobsFor(callbackJobs, IMMEDIATE_ID)[0]!.data as { ai_task_id: string; enqueued_at: number },
          attemptsMade: 0,
          opts: { attempts: 3 },
          timestamp: Date.now(),
        });
        await callbackWorker.process({
          name: 'deliver',
          data: jobsFor(callbackJobs, POLL_FAIL_ID)[0]!.data as { ai_task_id: string; enqueued_at: number },
          attemptsMade: 0,
          opts: { attempts: 3 },
          timestamp: Date.now(),
        });

        const successBody = JSON.parse(captured.get(WEBHOOK_ID)!.rawBody) as {
          status: string;
          result?: { output?: string };
          error: { code: string; message: string } | null;
        };
        const contextBody = JSON.parse(captured.get(IMMEDIATE_ID)!.rawBody) as typeof successBody;
        const failedBody = JSON.parse(captured.get(POLL_FAIL_ID)!.rawBody) as typeof successBody;
        expect(successBody, '10. success callback exposes result.output and a null error').toMatchObject({
          ai_task_id: WEBHOOK_ID,
          status: 'success',
          result: { output: 'chain output' },
          error: null,
          client_context: { run_id: 'run-chain', node_id: 'model', result_id: 'result-chain' },
        });
        expect(contextBody, '10. immediate callback keeps result.output').toMatchObject({
          status: 'success',
          result: { output: 'immediate hello' },
          error: null,
        });
        expect(failedBody, '10. failure callback exposes error and omits output').toMatchObject({
          status: 'failed',
          error: { code: 'provider_failed', message: 'provider failed' },
        });
        expect(failedBody.result).toBeUndefined();

        for (const aiTaskId of [WEBHOOK_ID, IMMEDIATE_ID, POLL_FAIL_ID]) {
          const capturedCallback = captured.get(aiTaskId);
          expect(capturedCallback, `11. callback ${aiTaskId} was posted`).toBeDefined();
          if (!capturedCallback) continue;
          const timestamp = capturedCallback.headers['x-oc-timestamp'];
          expect(timestamp).toBeTruthy();
          expect(capturedCallback.headers['x-oc-signature'], '11. signature covers the raw body').toBe(
            createConsumerCallbackSignature(CALLBACK_SECRET, timestamp ?? '', capturedCallback.rawBody),
          );
        }

        expect((await taskRepository.getById(WEBHOOK_ID))?.status, '12. 2xx success becomes succeeded').toBe('succeeded');
        expect((await taskRepository.getById(IMMEDIATE_ID))?.status, '12. 2xx success becomes succeeded').toBe('succeeded');
        expect((await taskRepository.getById(POLL_FAIL_ID))?.status, '12. 2xx with error becomes failed').toBe('failed');
        expect(dlqJobs, '12. successful delivery does not write DLQ').toEqual([]);

        const failJob = jobsFor(callbackJobs, FINAL_FAIL_ID)[0]!.data as { ai_task_id: string; enqueued_at: number };
        await expect(callbackWorker.process({
          name: 'deliver',
          data: failJob,
          attemptsMade: 0,
          opts: { attempts: 3 },
          timestamp: Date.now(),
        }), '13. non-2xx retries').rejects.toThrow(/503/);
        expect((await taskRepository.getById(FINAL_FAIL_ID))?.status).toBe('callback_pending');
        expect(dlqJobs).toEqual([]);
        await expect(callbackWorker.process({
          name: 'deliver',
          data: failJob,
          attemptsMade: 1,
          opts: { attempts: 3 },
          timestamp: Date.now(),
        }), '13. timeout retries').rejects.toThrow(/aborted|callback request failed/i);
        expect((await taskRepository.getById(FINAL_FAIL_ID))?.status).toBe('callback_pending');
        expect(dlqJobs).toEqual([]);
        await expect(callbackWorker.process({
          name: 'deliver',
          data: failJob,
          attemptsMade: 2,
          opts: { attempts: 3 },
          timestamp: Date.now(),
        })).rejects.toThrow(/503/);
        expect((await taskRepository.getById(FINAL_FAIL_ID))?.status, '14. exhausted retries become callback_failed').toBe('callback_failed');
        expect(dlqJobs, '14. exhausted retries write DLQ').toEqual([
          expect.objectContaining({
            name: 'failed',
            data: expect.objectContaining({
              ai_task_id: FINAL_FAIL_ID,
              attempts_made: 3,
              reason: expect.stringContaining('503') as string,
            }) as LoggedJob['data'],
            options: { jobId: `callback-dlq-${FINAL_FAIL_ID}` },
          }),
        ]);
        const failDeliveries = await deliveryRepository.listByTask(FINAL_FAIL_ID);
        expect(failDeliveries.map((delivery) => delivery.status)).toEqual(['failed', 'failed', 'failed']);

        const callbackFile = path.join(resultDir, 'callbacks.json');
        const frontendFile = path.join(resultDir, 'frontend-event.json');
        const consumerFile = path.join(resultDir, 'consumer.json');
        await writeFile(callbackFile, JSON.stringify({
          secret: CALLBACK_SECRET,
          success: captured.get(WEBHOOK_ID),
          context: captured.get(IMMEDIATE_ID),
        }));
        await runCommand(
          'uv',
          ['run', 'pytest', 'tests/test_provider_result_callback_chain.py', '-q', '-s'],
          CONSUMER_ROOT,
          {
            ...process.env,
            PROVIDER_CHAIN_CALLBACKS: callbackFile,
            PROVIDER_CHAIN_FRONTEND: frontendFile,
            PROVIDER_CHAIN_RESULT: consumerFile,
          },
        );
        await runCommand(
          'pnpm',
          ['exec', 'vitest', 'run', 'src/components/headBar/hooks/accept-ai-callback-workflow-event.test.ts'],
          FRONTEND_ROOT,
          { ...process.env, ACCEPT_WORKFLOW_EVENT_PATH: frontendFile },
        );
      } finally {
        await app.close();
        await rm(resultDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
