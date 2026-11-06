import type { AiTaskStatus } from '@novelcomic/contracts';

const TERMINAL_TASK_STATUS_SET: ReadonlySet<AiTaskStatus> = new Set([
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
]);

const TASK_STATUS_ORDER: Record<AiTaskStatus, number> = {
  received: 0,
  queued: 1,
  submitted_to_provider: 2,
  waiting_provider: 3,
  processing_artifacts: 4,
  callback_pending: 5,
  callback_failed: 6,
  callback_succeeded: 7,
  succeeded: 8,
  failed: 8,
  timed_out: 8,
  cancelled: 8,
  ignored: 8,
};

export class TaskStatusTransitionError extends Error {
  readonly code = 'TASK_STATUS_TRANSITION_INVALID';

  constructor(
    readonly from: AiTaskStatus,
    readonly to: AiTaskStatus,
  ) {
    super(`Cannot move task status from ${from} to ${to}`);
    this.name = 'TaskStatusTransitionError';
  }
}

export function isTerminalStatus(status: AiTaskStatus): boolean {
  return TERMINAL_TASK_STATUS_SET.has(status);
}

// This helper is intentionally not wired into every write path yet; provider fallback
// can still move a task from failed back to waiting_provider in later steps.
export function assertTaskStatusCanAdvance(from: AiTaskStatus, to: AiTaskStatus): void {
  if (from === to) {
    return;
  }

  if (isTerminalStatus(from) || TASK_STATUS_ORDER[to] < TASK_STATUS_ORDER[from]) {
    throw new TaskStatusTransitionError(from, to);
  }
}
