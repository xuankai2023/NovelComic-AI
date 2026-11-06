export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | {
    [key: string]: JsonValue;
};
export type JsonObject = Record<string, JsonValue>;
export type CoreProvider = 'byteplus' | 'kie' | 'unknown' | (string & {});
export type CoreProviderResultMode = 'sync' | 'polling' | 'webhook';
export type CoreProviderResultStatus = 'succeeded' | 'failed' | 'processing';
export interface CoreProviderResult {
    status: CoreProviderResultStatus;
    outputs?: JsonObject;
    error?: {
        code: string;
        message: string;
        retryable?: boolean;
        details?: JsonValue;
    };
    raw?: unknown;
}
export interface CoreSubmitInput<TOptions extends JsonObject = JsonObject> {
    ai_task_id: string;
    model_id: string;
    options: TOptions;
    webhook_url?: string;
}
export interface CoreSubmitResult {
    provider: CoreProvider;
    model_id: string;
    request_id?: string;
    provider_request_id?: string;
    status: 'submitted' | 'succeeded';
    provider_status?: string;
    result_mode?: CoreProviderResultMode;
    raw?: unknown;
    result?: CoreProviderResult;
}
export interface CoreProviderCall<TOptions extends JsonObject = JsonObject, TRawResult = unknown> {
    provider: CoreProvider;
    model_id: string;
    options_schema?: JsonObject;
    result_mode: CoreProviderResultMode;
    submit(input: CoreSubmitInput<TOptions>): Promise<CoreSubmitResult>;
    getResult?(input: {
        request_id: string;
        model_id: string;
    }): Promise<TRawResult>;
    normalizeResult(raw: TRawResult): CoreProviderResult;
}
export interface CoreModelEntity {
    id: string;
    displayName: string;
    aliases?: readonly string[];
    robin_calls?: readonly CoreProviderCall[];
}
export interface CoreRunContext<TOptions extends JsonObject = JsonObject> {
    ai_task_id: string;
    model_id: string;
    options: TOptions;
    webhook_url: string;
    skip_providers?: readonly string[];
}
