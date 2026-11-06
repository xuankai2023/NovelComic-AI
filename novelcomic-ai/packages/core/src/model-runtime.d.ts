import type { CoreModelEntity, CoreRunContext, CoreSubmitResult, JsonObject } from './types.js';
export type { CoreModelEntity } from './types.js';
export declare class CoreModelNotRegisteredError extends Error {
    readonly modelId: string;
    readonly code = "MODEL_NOT_REGISTERED";
    constructor(modelId: string);
}
export declare const CORE_MODELS: CoreModelEntity[];
export declare function registerCoreModel(model: CoreModelEntity): CoreModelEntity;
export declare function listCoreModels(): CoreModelEntity[];
export declare function resolveCoreModelId(modelId: string): string;
export declare function requireCoreModel(modelId: string): CoreModelEntity;
export declare function extractRequestedProviderFromOptions(options: JsonObject): string | undefined;
export declare function stripProviderFromOptions<TOptions extends JsonObject>(options: TOptions): JsonObject;
export declare function validateCoreModelOptions<TOptions extends JsonObject>(modelId: string, options: TOptions): JsonObject;
export declare function getRemainingRobinProviders(modelId: string, currentProvider: string, currentProviderModelId?: string, taskOptions?: JsonObject): Array<{
    provider: string;
    model_id: string;
}>;
export interface SubmitCoreTaskInput<TOptions extends JsonObject = JsonObject> extends CoreRunContext<TOptions> {
}
export declare function submitCoreTask<TOptions extends JsonObject = JsonObject>(input: SubmitCoreTaskInput<TOptions>): Promise<CoreSubmitResult>;
export declare class CoreProviderNotAvailableError extends Error {
    readonly modelId: string;
    readonly provider: string;
    readonly code = "PROVIDER_NOT_AVAILABLE";
    constructor(modelId: string, provider: string);
}
export declare class CoreProviderCallNotFoundError extends Error {
    readonly modelId: string;
    readonly provider?: string | undefined;
    readonly code = "PROVIDER_CALL_NOT_FOUND";
    constructor(modelId: string, provider?: string | undefined);
}
export declare class CoreProviderSubmitError extends Error {
    readonly modelId: string;
    readonly provider: string;
    readonly providerModelId: string;
    readonly cause: unknown;
    readonly code = "PROVIDER_SUBMIT_FAILED";
    constructor(modelId: string, provider: string, providerModelId: string, cause: unknown);
}
export interface ParsedCoreProviderWebhook {
    ai_task_id?: string;
    provider_request_id?: string;
    provider_model_id?: string;
    provider_status?: string;
    event_id?: string;
    event_type?: string;
    attempt?: number;
}
export declare function parseCoreProviderWebhook(provider: string, payload: unknown, headers: Record<string, string | undefined>): ParsedCoreProviderWebhook;
export declare function verifyTencentWebhookSignature(payload: unknown, signKey: string | undefined, nowSec?: number): {
    valid: boolean;
    reason?: string;
};
