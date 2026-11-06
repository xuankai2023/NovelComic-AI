export declare const DEFAULT_REDIS_TTL_SECONDS = 86400;
export declare const DEFAULT_WORKER_HEARTBEAT_PREFIX = "novelcomic";
export declare const WORKER_HEARTBEAT_NAME = "worker";
export declare const WORKER_HEARTBEAT_INTERVAL_MS = 30000;
export declare function redisDefaultTtlSeconds(env?: NodeJS.ProcessEnv): number;
export declare function workerReadyzKey(prefix: string, workerName: string): string;
export interface WorkerHeartbeatWriter {
    set(key: string, value: string, expiryMode: 'EX', ttlSeconds: number): Promise<unknown>;
}
export interface WorkerHeartbeatReader {
    get(key: string): Promise<string | null>;
}
export declare function writeWorkerHeartbeat(redis: WorkerHeartbeatWriter, workerName?: string, options?: {
    prefix?: string;
    ttlSeconds?: number;
}): Promise<void>;
export declare function readWorkerHeartbeat(redis: WorkerHeartbeatReader, workerName?: string, options?: {
    prefix?: string;
}): Promise<string | null>;
export declare function startWorkerHeartbeat(redis: WorkerHeartbeatWriter, options?: {
    prefix?: string;
    ttlSeconds?: number;
    intervalMs?: number;
    workerName?: string;
}): {
    stop: () => void;
};
