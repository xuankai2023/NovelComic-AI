import type { CoreSubmitResult, JsonObject, JsonValue } from '../types.js';
export declare const DEFAULT_KIE_BASE_URL = "https://api.kie.ai/api/v1";
export type KieResponseBody = JsonValue;
export interface KieClientConfig {
    apiKey: string;
    baseUrl?: string;
    fetch?: typeof fetch;
}
export interface KieSubmitInput {
    model_id: string;
    endpoint: string;
    options: JsonObject;
    webhook_url?: string;
}
export interface KieGetResultInput {
    endpoint: string;
    request_id: string;
}
export interface KieCancelInput {
    endpoint: string;
    request_id: string;
}
export declare class KieProviderClient {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly fetchImpl;
    constructor(config: KieClientConfig);
    submit(input: KieSubmitInput): Promise<CoreSubmitResult>;
    getResult(input: KieGetResultInput): Promise<KieResponseBody>;
    cancel(input: KieCancelInput): Promise<KieResponseBody>;
    private request;
}
export declare class KieProviderRequestError extends Error {
    readonly status: number;
    readonly statusText: string;
    readonly body: KieResponseBody;
    readonly code = "KIE_PROVIDER_REQUEST_FAILED";
    constructor(status: number, statusText: string, body: KieResponseBody);
}
