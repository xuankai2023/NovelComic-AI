import { describe, expect, it } from 'vitest';
import {
  assertTaskStatusCanAdvance,
  isTerminalStatus,
  TaskStatusTransitionError,
} from './state-machine.js';

describe('state machine helpers', () => {
  it('allows same-status and forward task status transitions', () => {
    expect(() => assertTaskStatusCanAdvance('queued', 'queued')).not.toThrow();
    expect(() => assertTaskStatusCanAdvance('queued', 'waiting_provider')).not.toThrow();
    expect(() => assertTaskStatusCanAdvance('callback_pending', 'succeeded')).not.toThrow();
  });

  it('rejects backward task status transitions', () => {
    expect(() => assertTaskStatusCanAdvance('waiting_provider', 'queued')).toThrow(
      TaskStatusTransitionError,
    );
  });

  it('rejects transitions out of terminal task statuses', () => {
    expect(() => assertTaskStatusCanAdvance('failed', 'waiting_provider')).toThrow(
      TaskStatusTransitionError,
    );
    expect(() => assertTaskStatusCanAdvance('succeeded', 'callback_pending')).toThrow(
      TaskStatusTransitionError,
    );
  });

  it('detects terminal task statuses', () => {
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('timed_out')).toBe(true);
    expect(isTerminalStatus('waiting_provider')).toBe(false);
  });
});
