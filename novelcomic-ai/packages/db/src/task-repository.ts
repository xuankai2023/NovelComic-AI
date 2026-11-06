import type { AiTaskDocument, AiTaskError, AiTaskStatus, JsonValue, ProviderTelemetry } from '@novelcomic/contracts';
import type { Collection, Db, Document, WithId } from 'mongodb';
import { COLLECTIONS } from './collections.js';

export const AI_TASK_COLLECTION_NAME = COLLECTIONS.aiTask;

export type CreateTaskResult =
  | { status: 'created'; task: AiTaskDocument }
  | { status: 'existing'; task: AiTaskDocument };

export interface ProviderSubmittedUpdate {
  ai_task_id: string;
  provider: string;
  provider_model_id: string;
  provider_request_id?: string;
  provider_status: string;
  result_mode: 'sync' | 'polling' | 'webhook';
  attempt: number;
}

export interface ProviderFailedAttemptUpdate {
  ai_task_id: string;
  provider?: string;
  provider_model_id?: string;
  provider_request_id?: string;
  provider_status?: string;
  attempt: number;
  error: AiTaskError;
  skip_provider?: string;
  has_fallback: boolean;
}

export interface ProviderResultUpdate {
  status: 'succeeded' | 'failed' | 'processing';
  outputs?: JsonValue;
  error?: AiTaskError;
}

export interface TaskRepositoryOptions {
  collectionName?: string;
}

export class AiTaskNotFoundError extends Error {
  readonly code = 'AI_TASK_NOT_FOUND';

  constructor(readonly aiTaskId: string) {
    super(`AI task not found: ${aiTaskId}`);
    this.name = 'AiTaskNotFoundError';
  }
}

export class TaskRepositoryConflictError extends Error {
  readonly code = 'TASK_REPOSITORY_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'TaskRepositoryConflictError';
  }
}

export class TaskRepository {
  private readonly collection: Collection<AiTaskDocument>;

  constructor(dbOrCollection: Db | Collection<AiTaskDocument>, options: TaskRepositoryOptions = {}) {
    this.collection = isCollection(dbOrCollection)
      ? dbOrCollection
      : dbOrCollection.collection<AiTaskDocument>(options.collectionName ?? AI_TASK_COLLECTION_NAME);
  }

  public async ensureIndexes(): Promise<void> {
    await Promise.all([
      safeCreateIndex(this.collection, { ai_task_id: 1 }, { unique: true, name: 'ai_task_id_unique' }),
      safeCreateIndex(
        this.collection,
        { idempotency_key: 1 },
        { unique: true, sparse: true, name: 'idempotency_key_unique_sparse' },
      ),
      safeCreateIndex(this.collection, { trace_id: 1 }, { name: 'trace_id' }),
      safeCreateIndex(this.collection, { status: 1 }, { name: 'status' }),
      safeCreateIndex(
        this.collection,
        { provider_request_id: 1 },
        { sparse: true, name: 'provider_request_id_sparse' },
      ),
      safeCreateIndex(this.collection, { created_at: 1 }, { name: 'created_at' }),
    ]);
  }

  public async createOrGet(task: AiTaskDocument): Promise<CreateTaskResult> {
    if (!task.idempotency_key) {
      await this.collection.insertOne(task);
      return { status: 'created', task };
    }

    try {
      await this.collection.insertOne(task);
      return { status: 'created', task };
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }

      const existing = await this.collection.findOne({ idempotency_key: task.idempotency_key });
      if (!existing) {
        throw new TaskRepositoryConflictError('Duplicate task detected but existing task was not found');
      }

      return { status: 'existing', task: stripMongoId(existing) };
    }
  }

  public async getById(aiTaskId: string): Promise<AiTaskDocument | null> {
    const task = await this.collection.findOne({ ai_task_id: aiTaskId });
    return task ? stripMongoId(task) : null;
  }

  public async requireByAiTaskId(aiTaskId: string): Promise<AiTaskDocument> {
    const task = await this.getById(aiTaskId);
    if (!task) {
      throw new AiTaskNotFoundError(aiTaskId);
    }
    return task;
  }

  public async findByProviderRequestId(providerRequestId: string): Promise<AiTaskDocument | null> {
    const task = await this.collection.findOne({ provider_request_id: providerRequestId });
    return task ? stripMongoId(task) : null;
  }

  public async updateStatus(aiTaskId: string, status: AiTaskStatus): Promise<void> {
    await this.collection.updateOne(
      { ai_task_id: aiTaskId },
      { $set: { status, updated_at: new Date() } },
    );
  }

  public async updateResult(aiTaskId: string, result: JsonValue): Promise<void> {
    await this.collection.updateOne(
      { ai_task_id: aiTaskId },
      { $set: { result, updated_at: new Date() } },
    );
  }

  public async updateProviderTelemetry(aiTaskId: string, telemetry: Partial<ProviderTelemetry>): Promise<void> {
    const $set = buildTelemetrySet(telemetry);
    $set.updated_at = new Date();

    await this.collection.updateOne(
      { ai_task_id: aiTaskId },
      { $set },
    );
  }

  public async claimModelCallNotification(aiTaskId: string): Promise<boolean> {
    const result = await this.collection.updateOne(
      {
        ai_task_id: aiTaskId,
        model_call_notify_status: { $exists: false },
      },
      {
        $set: {
          model_call_notify_status: 'sending',
          updated_at: new Date(),
        },
      },
    );

    return result.modifiedCount === 1;
  }

  public async markModelCallNotificationSent(aiTaskId: string): Promise<void> {
    await this.collection.updateOne(
      { ai_task_id: aiTaskId },
      {
        $set: {
          model_call_notify_status: 'sent',
          model_call_notified_at: new Date(),
          updated_at: new Date(),
        },
        $unset: {
          model_call_notify_error: '',
        },
      },
    );
  }

  public async markModelCallNotificationFailed(aiTaskId: string, error: string): Promise<void> {
    await this.collection.updateOne(
      { ai_task_id: aiTaskId },
      {
        $set: {
          model_call_notify_status: 'failed',
          model_call_notify_error: error,
          updated_at: new Date(),
        },
      },
    );
  }

  public async markProviderSubmitted(input: ProviderSubmittedUpdate): Promise<AiTaskDocument> {
    const update: Partial<AiTaskDocument> = {
      status: 'waiting_provider',
      provider: input.provider,
      provider_model_id: input.provider_model_id,
      provider_status: input.provider_status,
      result_mode: input.result_mode,
      attempt: input.attempt,
      attempts: input.attempt,
      updated_at: new Date(),
    };
    if (input.provider_request_id) {
      update.provider_request_id = input.provider_request_id;
    }

    await this.collection.updateOne(
      { ai_task_id: input.ai_task_id },
      { $set: update },
    );
    return this.requireByAiTaskId(input.ai_task_id);
  }

  public async markProviderFailedAttempt(input: ProviderFailedAttemptUpdate): Promise<AiTaskDocument> {
    const task = await this.requireByAiTaskId(input.ai_task_id);
    const skipProviders = input.skip_provider
      ? [...new Set([...(task.skip_providers ?? []), input.skip_provider])]
      : task.skip_providers;
    const update: Partial<AiTaskDocument> = {
      status: input.has_fallback ? 'queued' : 'failed',
      provider_status: input.provider_status ?? 'failed',
      attempt: input.attempt,
      attempts: input.attempt,
      error: input.error,
      updated_at: new Date(),
    };
    if (input.provider) {
      update.provider = input.provider;
    }
    if (input.provider_model_id) {
      update.provider_model_id = input.provider_model_id;
    }
    if (input.provider_request_id) {
      update.provider_request_id = input.provider_request_id;
    }
    if (skipProviders) {
      update.skip_providers = skipProviders;
    }

    await this.collection.updateOne(
      { ai_task_id: input.ai_task_id },
      { $set: update },
    );
    return this.requireByAiTaskId(input.ai_task_id);
  }

  public async applyProviderResult(aiTaskId: string, result: ProviderResultUpdate): Promise<AiTaskDocument> {
    const update: Partial<AiTaskDocument> = {
      status: providerResultStatusToTaskStatus(result.status),
      provider_status: result.status,
      updated_at: new Date(),
    };

    if (result.status === 'succeeded' && result.outputs !== undefined) {
      update.result = result.outputs;
    }
    if (result.status === 'failed') {
      update.error = result.error ?? {
        code: 'provider_result_failed',
        message: 'Provider returned a failed result',
        retryable: false,
      };
    }

    await this.collection.updateOne(
      { ai_task_id: aiTaskId },
      { $set: update },
    );
    return this.requireByAiTaskId(aiTaskId);
  }
}

function isCollection(input: Db | Collection<AiTaskDocument>): input is Collection<AiTaskDocument> {
  return 'insertOne' in input && typeof input.insertOne === 'function';
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

async function safeCreateIndex<T extends Document>(
  collection: Collection<T>,
  indexSpec: Record<string, 1 | -1>,
  options: { unique?: boolean; sparse?: boolean; name: string },
): Promise<void> {
  try {
    await collection.createIndex(indexSpec, options);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 85 || error.code === 86)) {
      return;
    }
    throw error;
  }
}

function stripMongoId<T extends object>(document: WithId<T>): T {
  const { _id: ignored, ...rest } = document;
  void ignored;
  return rest as T;
}

function buildTelemetrySet(telemetry: Partial<ProviderTelemetry>): Record<string, unknown> {
  const $set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(telemetry)) {
    if (value !== undefined) {
      $set[`provider_telemetry.${key}`] = value;
    }
  }
  return $set;
}

function providerResultStatusToTaskStatus(status: ProviderResultUpdate['status']): AiTaskStatus {
  if (status === 'succeeded') {
    return 'processing_artifacts';
  }
  if (status === 'failed') {
    return 'failed';
  }
  return 'waiting_provider';
}
