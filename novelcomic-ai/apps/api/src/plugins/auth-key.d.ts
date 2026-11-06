export interface AuthKeyHookConfig {
    security: {
        authKey: string;
    };
}
interface AuthKeyRequest {
    url: string;
    method: string;
    headers: Record<string, string | string[] | undefined>;
    log: {
        warn(fields: Record<string, unknown>, message?: string): void;
    };
}
interface AuthKeyReply {
    code(statusCode: number): {
        send(payload: unknown): unknown;
    };
}
interface AuthKeyApp {
    addHook(name: 'preHandler', handler: (request: AuthKeyRequest, reply: AuthKeyReply) => Promise<unknown>): void;
}
export declare function registerAuthKeyHook(app: AuthKeyApp, config: AuthKeyHookConfig): void;
export {};
