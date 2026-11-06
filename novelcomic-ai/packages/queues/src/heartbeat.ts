export const DEFAULT_REDIS_TTL_SECONDS = 86_400;
export const DEFAULT_WORKER_HEARTBEAT_PREFIX = 'novelcomic';
export const WORKER_HEARTBEAT_NAME = 'worker';
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;

export function redisDefaultTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REDIS_DEFAULT_TTL_SECONDS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_REDIS_TTL_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_REDIS_TTL_SECONDS;
  }
  return parsed;
}

export function workerReadyzKey(prefix: string, workerName: string): string {
  return `${prefix}:readyz:worker:${workerName}`;
}

export interface WorkerHeartbeatWriter {
  set(key: string, value: string, expiryMode: 'EX', ttlSeconds: number): Promise<unknown>;
}

export interface WorkerHeartbeatReader {
  get(key: string): Promise<string | null>;
}

export async function writeWorkerHeartbeat(
  redis: WorkerHeartbeatWriter,
  workerName: string = WORKER_HEARTBEAT_NAME,
  options: { prefix?: string; ttlSeconds?: number } = {},
): Promise<void> {
  const prefix = options.prefix ?? DEFAULT_WORKER_HEARTBEAT_PREFIX;
  const ttlSeconds = options.ttlSeconds ?? redisDefaultTtlSeconds();
  await redis.set(workerReadyzKey(prefix, workerName), new Date().toISOString(), 'EX', ttlSeconds);
}

export async function readWorkerHeartbeat(
  redis: WorkerHeartbeatReader,
  workerName: string = WORKER_HEARTBEAT_NAME,
  options: { prefix?: string } = {},
): Promise<string | null> {
  const prefix = options.prefix ?? DEFAULT_WORKER_HEARTBEAT_PREFIX;
  return redis.get(workerReadyzKey(prefix, workerName));
}

export function startWorkerHeartbeat(
  redis: WorkerHeartbeatWriter,
  options: { prefix?: string; ttlSeconds?: number; intervalMs?: number; workerName?: string } = {},
): { stop: () => void } {
  const workerName = options.workerName ?? WORKER_HEARTBEAT_NAME;
  const intervalMs = options.intervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS;
  const writeOptions: { prefix?: string; ttlSeconds?: number } = {};
  if (options.prefix !== undefined) {
    writeOptions.prefix = options.prefix;
  }
  if (options.ttlSeconds !== undefined) {
    writeOptions.ttlSeconds = options.ttlSeconds;
  }
  let stopped = false;
  const tick = (): void => {
    if (stopped) {
      return;
    }
    void writeWorkerHeartbeat(redis, workerName, writeOptions).catch(() => undefined);
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
