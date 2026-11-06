import type { CoreSubmitResult, JsonObject } from '../types.js';
export declare const BAIDU_GPT_IMAGE_MODEL = "gpt-image-2";
export declare const BAIDU_GPT_IMAGE_GENERATE_PATH = "/v3/aigc/v1/images/generations";
export declare const BAIDU_GPT_IMAGE_EDIT_PATH = "/v3/aigc/v1/images/edits";
export declare const DEFAULT_BAIDU_BASE_URL = "https://vod.bj.baidubce.com";
export type BaiduGptImageTaskType = 'generate' | 'edit';
export interface BaiduGptImageClientConfig {
    apiKey: string;
    baseUrl?: string;
    fetch?: typeof fetch;
}
export declare class BaiduGptImageClient {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly fetchImpl;
    constructor(config: BaiduGptImageClientConfig);
    submit(input: {
        taskType: BaiduGptImageTaskType;
        options: JsonObject;
    }): Promise<CoreSubmitResult>;
    private submitEdit;
}
export declare function buildBaiduGptImageRequestBody(input: JsonObject): JsonObject;
export declare function extractBaiduGptImageDataUrls(body: JsonObject): string[];
export declare function baiduSize(input: JsonObject): string;
