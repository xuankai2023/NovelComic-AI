import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REDIS_TTL_SECONDS,
  WORKER_HEARTBEAT_NAME,
  readWorkerHeartbeat,
  redisDefaultTtlSeconds,
  startWorkerHeartbeat,
  workerReadyzKey,
  writeWorkerHeartbeat,
  type WorkerHeartbeatReader,
  type WorkerHeartbeatWriter,
} from './heartbeat.js';

describe('worker heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the default ttl and the readyz worker key', () => {
    expect(redisDefaultTtlSeconds({})).toBe(DEFAULT_REDIS_TTL_SECONDS);
    expect(redisDefaultTtlSeconds({ REDIS_DEFAULT_TTL_SECONDS: '120' })).toBe(120);
    expect(redisDefaultTtlSeconds({ REDIS_DEFAULT_TTL_SECONDS: '0' })).toBe(DEFAULT_REDIS_TTL_SECONDS);
    expect(workerReadyzKey('novelcomic', WORKER_HEARTBEAT_NAME)).toBe('novelcomic:readyz:worker:worker');
  });

  it('writes an iso timestamp with the default ttl', async () => {
    const writes: unknown[][] = [];
    const redis: WorkerHeartbeatWriter = {
      async set(...args) {
        writes.push(args);
      },
    };
    const previous = process.env.REDIS_DEFAULT_TTL_SECONDS;
    delete process.env.REDIS_DEFAULT_TTL_SECONDS;
    try {
      await writeWorkerHeartbeat(redis, 'worker', { prefix: 'novelcomic' });
    } finally {
      if (previous === undefined) {
        delete process.env.REDIS_DEFAULT_TTL_SECONDS;
      } else {
        process.env.REDIS_DEFAULT_TTL_SECONDS = previous;
      }
    }
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toBe('novelcomic:readyz:worker:worker');
    expect(writes[0]?.[1]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(writes[0]?.[2]).toBe('EX');
    expect(writes[0]?.[3]).toBe(86_400);
  });

  it('reads the stored heartbeat', async () => {
    const redis: WorkerHeartbeatReader = {
      async get(key) {
        expect(key).toBe('novelcomic:readyz:worker:worker');
        return '2026-09-30T01:02:03.000Z';
      },
    };
    await expect(readWorkerHeartbeat(redis, 'worker', { prefix: 'novelcomic' })).resolves.toBe(
      '2026-09-30T01:02:03.000Z',
    );
  });

  it('writes once immediately and again every 30 seconds', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const redis: WorkerHeartbeatWriter = {
      async set(_key, value) {
        writes.push(value);
      },
    };
    const heartbeat = startWorkerHeartbeat(redis, { prefix: 'novelcomic', ttlSeconds: 86_400, intervalMs: 30_000 });
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writes).toHaveLength(2);
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writes).toHaveLength(2);
  });
});
