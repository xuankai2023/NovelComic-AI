import type { AiTaskDocument, CreateAiTaskRequest, CreateAiTaskResponse } from '@novelcomic/contracts';
export type ProviderExecutionJob = {
    ai_task_id: string;
    skip_providers?: string[];
};
export interface TaskSubmitQueue {
    add(name: string, data: ProviderExecutionJob, options?: {
        jobId?: string;
    }): Promise<unknown>;
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
export declare class TaskServiceValidationError extends Error {
    readonly validation: TaskServiceValidationDetails;
    readonly code = "TASK_VALIDATION_ERROR";
    constructor(message: string, validation: TaskServiceValidationDetails);
}
export declare class TaskService {
    private readonly taskRepository;
    private readonly providerExecutionQueue;
    constructor(taskRepository: AiTaskWriteRepository, providerExecutionQueue: TaskSubmitQueue);
    createTask(request: CreateAiTaskRequest): Promise<CreateAiTaskResponse>;
    private validateOptions;
}
