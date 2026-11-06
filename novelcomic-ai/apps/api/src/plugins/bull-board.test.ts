import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registerBullBoard, type BullBoardApp } from './bull-board.js';

function recordingApp(): BullBoardApp & { routes: string[] } {
  const routes: string[] = [];
  return {
    routes,
    get(path) {
      routes.push(path);
    },
  };
}

describe('Bull Board gate', () => {
  it('does not register a route when ENABLE_BULL_BOARD is unset', async () => {
    const app = recordingApp();
    await registerBullBoard(app, false);
    expect(app.routes).toEqual([]);
  });

  it('registers /admin/queues only when the switch is on', async () => {
    const app = recordingApp();
    await registerBullBoard(app, true);
    expect(app.routes).toEqual(['/admin/queues']);
  });

  it('keeps assertTaskStatusCanAdvance off the worker entry import list', () => {
    const worker = readFileSync(new URL('../../../worker/src/index.ts', import.meta.url), 'utf8');
    expect(worker).not.toContain('assertTaskStatusCanAdvance');
  });
});