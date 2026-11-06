export interface HealthRouteDependencies {
    mongo: {
        db: {
            command(command: {
                ping: 1;
            }): Promise<unknown>;
        };
    };
    redis: {
        ping(): Promise<unknown>;
        get(key: string): Promise<string | null>;
    };
}
interface HealthReply {
    code(statusCode: number): HealthReply;
    send(payload: unknown): unknown;
}
interface HealthApp {
    get(path: string, handler: (request: unknown, reply: HealthReply) => unknown): unknown;
}
export declare function registerHealthRoutes(app: HealthApp, options: HealthRouteDependencies): void;
export {};
