import { pingMongo } from '@novelcomic/db';
import {
  QUEUE_PREFIX,
  WORKER_HEARTBEAT_NAME,
  readWorkerHeartbeat,
} from '@novelcomic/queues';
import type { Db } from 'mongodb';

export interface HealthRouteDependencies {
  mongo: { db: { command(command: { ping: 1 }): Promise<unknown> } };
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

export function registerHealthRoutes(app: HealthApp, options: HealthRouteDependencies): void {
  app.get('/health', async () => ({ status: 'ok', service: 'novelcomic-api' }));

  app.get('/readyz', async (_request, reply) => {
    const [mongoOk, redisOk, workerHeartbeat] = await Promise.all([
      pingMongo(options.mongo.db as unknown as Db).then(
        () => true,
        () => false,
      ),
      options.redis.ping().then(
        () => true,
        () => false,
      ),
      readWorkerHeartbeat(options.redis, WORKER_HEARTBEAT_NAME, { prefix: QUEUE_PREFIX }).catch(() => null),
    ]);
    const ready = mongoOk && redisOk;
    const body = {
      status: ready ? 'ready' : 'not_ready',
      mongo: mongoOk,
      redis: redisOk,
      worker_heartbeat: workerHeartbeat,
    };
    if (!ready) {
      return reply.code(503).send(body);
    }
    return body;
  });
}
