import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerHealthRoutes, type HealthRouteDependencies } from './health.js';

function mongo(ok: boolean): HealthRouteDependencies['mongo'] {
  return {
    db: {
      async command() {
        if (!ok) {
          throw new Error('mongo down');
        }
        return { ok: 1 };
      },
    },
  };
}

describe('ai health routes', () => {
  it('reports process health without checking dependencies', async () => {
    const app = Fastify();
    registerHealthRoutes(app, {
      mongo: mongo(false),
      redis: {
        async ping() {
          throw new Error('redis down');
        },
        async get() {
          return null;
        },
      },
    });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'novelcomic-api' });
    await app.close();
  });

  it('stays ready when the worker heartbeat is missing', async () => {
    const app = Fastify();
    registerHealthRoutes(app, {
      mongo: mongo(true),
      redis: {
        async ping() {
          return 'PONG';
        },
        async get() {
          return null;
        },
      },
    });
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      mongo: true,
      redis: true,
      worker_heartbeat: null,
    });
    await app.close();
  });

  it('returns a stored heartbeat without using it as the ready signal', async () => {
    const app = Fastify();
    registerHealthRoutes(app, {
      mongo: mongo(true),
      redis: {
        async ping() {
          return 'PONG';
        },
        async get(key) {
          expect(key).toBe('novelcomic:readyz:worker:worker');
          return '2026-09-30T01:02:03.000Z';
        },
      },
    });
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json().worker_heartbeat).toBe('2026-09-30T01:02:03.000Z');
    await app.close();
  });

  it('returns 503 when mongo is down and still includes the heartbeat field', async () => {
    const app = Fastify();
    registerHealthRoutes(app, {
      mongo: mongo(false),
      redis: {
        async ping() {
          return 'PONG';
        },
        async get() {
          return '2026-09-30T01:02:03.000Z';
        },
      },
    });
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      mongo: false,
      redis: true,
      worker_heartbeat: '2026-09-30T01:02:03.000Z',
    });
    await app.close();
  });

  it('turns a heartbeat read failure into null while redis itself is up', async () => {
    const app = Fastify();
    registerHealthRoutes(app, {
      mongo: mongo(true),
      redis: {
        async ping() {
          return 'PONG';
        },
        async get() {
          throw new Error('read failed');
        },
      },
    });
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json().worker_heartbeat).toBeNull();
    await app.close();
  });
});
