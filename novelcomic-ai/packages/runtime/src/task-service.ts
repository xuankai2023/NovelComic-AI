import type { AiTaskDocument, CreateAiTaskRequest, CreateAiTaskResponse } from '@novelcomic/contracts';
import {
  CoreModelNotRegisteredError,
  CoreModelOptionsValidationError,
  resolveCoreModelId,
  validateCoreModelOptions,
} from '@novelcomic/core';
import { randomBytes } from 'node:crypto';

export type ProviderExecutionJob = { ai_task_id: string; skip_providers?: string[] };

export interface TaskSubmitQueue {
  add(name: string, data: ProviderExecutionJob, options?: { jobId?: string }): Promise<unknown>;
}

export interface AiTaskWriteRepository {
  createOrGet(task: AiTaskDocument): Promise<{
    status: 'created' | 'existing';
    task: AiTaskDocument;
  }>;
}

export interface TaskServiceValidationDetails {
  code: string;
  details?: unknown;
}

export class TaskServiceValidationError extends Error {
  readonly code = 'TASK_VALIDATION_ERROR';

  constructor(
    message: string,
    readonly validation: TaskServiceValidationDetails,
  ) {
    super(message);
    this.name = 'TaskServiceValidationError';
  }
}

export class TaskService {
  constructor(
    private readonly taskRepository: AiTaskWriteRepository,
    private readonly providerExecutionQueue: TaskSubmitQueue,
  ) {}

  public async createTask(request: CreateAiTaskRequest): Promise<CreateAiTaskResponse> {
    const coreModelId = resolveCoreModelId(request.model_id);
    const options = this.validateOptions(coreModelId, request.options);
    const now = new Date();
    const task: AiTaskDocument = {
      ai_task_id: createAiTaskId(),
      status: 'queued',
      model_id: request.model_id,
      core_model_id: coreModelId,
      options,
      webhook_url: request.webhook_url,
      ...(request.trace_id ? { trace_id: request.trace_id } : {}),
      ...(request.idempotency_key ? { idempotency_key: request.idempotency_key } : {}),
      ...(request.locale ? { locale: request.locale } : {}),
      ...(request.client_context ? { client_context: request.client_context } : {}),
      created_at: now,
      updated_at: now,
    };

    const result = await this.taskRepository.createOrGet(task);
    if (result.status === 'created') {
      await this.providerExecutionQueue.add(
        'submit',
        { ai_task_id: result.task.ai_task_id },
        { jobId: `provider-${result.task.ai_task_id}` },
      );
    }

    return {
      ai_task_id: result.task.ai_task_id,
      status: result.status === 'created' ? 'queued' : 'existing',
    };
  }

  private validateOptions(
    coreModelId: string,
    options: CreateAiTaskRequest['options'],
  ): CreateAiTaskRequest['options'] {
    try {
      return validateCoreModelOptions(coreModelId, options);
    } catch (error) {
      if (error instanceof CoreModelNotRegisteredError) {
        throw new TaskServiceValidationError(error.message, {
          code: error.code,
          details: { model_id: error.modelId },
        });
      }

      if (error instanceof CoreModelOptionsValidationError) {
        throw new TaskServiceValidationError(error.message, {
          code: error.code,
          details: { core_model_id: error.coreModelId, issues: error.issues },
        });
      }

      throw error;
    }
  }
}

function createAiTaskId(): string {
  return `task_${Date.now()}_${randomBytes(6).toString('hex')}`;
}
