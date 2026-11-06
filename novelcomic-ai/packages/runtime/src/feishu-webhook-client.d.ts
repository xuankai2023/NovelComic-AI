export interface RuntimeLogger {
    info(fields: Record<string, unknown>, message: string): void;
    warn?(fields: Record<string, unknown>, message: string): void;
}
export type FeishuWebhookClientOptions = {
    enabled?: boolean | undefined;
    webhookUrl?: string | undefined;
    secret?: string | undefined;
    timeoutMs?: number | undefined;
    logger?: RuntimeLogger | undefined;
};
export type FeishuTextMessage = {
    text: string;
    atAll?: boolean | undefined;
};
export declare class FeishuWebhookClient {
    private readonly options;
    constructor(options: FeishuWebhookClientOptions);
    sendText(message: FeishuTextMessage): Promise<void>;
}
export declare function buildFeishuTextPayload(text: string, secret?: string, options?: {
    atAll?: boolean | undefined;
}): Record<string, unknown>;
export declare function createFeishuSignature(timestamp: string, secret: string): string;
