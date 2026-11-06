import { describe, expect, it } from 'vitest';
import {
  CallbackWorkerProcessor,
  type CallbackDlqJobData,
  type CallbackWorkerJob,
  type ConsumerCallbackJobData,
} from './callback-worker.js';
import { AlertFeishuNotifier } from './feishu-notifier.js';

function createJob(overrides: Partial<CallbackWorkerJob<ConsumerCallbackJobData>> = {}): CallbackWorkerJob<ConsumerCallbackJobData> {
  return {
    id: 'job-1',
    name: 'deliver',
    data: { ai_task_id: 'task-callback-1', enqueued_at: 1_000 },
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: 1_000,
    ...overrides,
  };
}

describe('CallbackWorkerProcessor', () => {
  it('delivers the callback with the BullMQ attempt number', async () => {
    const delivered: unknown[] = [];
    const dlqJobs: unknown[] = [];
    const processor = new CallbackWorkerProcessor(
      {
        async deliver(aiTaskId, options) {
          delivered.push({ aiTaskId, options });
        },
        async markFailed() {
          throw new Error('markFailed should not be called');
        },
      },
      {
        async add(name, data, options) {
          dlqJobs.push({ name, data, options });
          return null;
        },
      },
    );

    await expect(processor.process(createJob({ attemptsMade: 1 }))).resolves.toBeUndefined();

    expect(delivered).toEqual([{ aiTaskId: 'task-callback-1', options: { callbackAttempt: 2 } }]);
    expect(dlqJobs).toEqual([]);
  });

  it('marks the task failed and writes DLQ when attempts are exhausted', async () => {
    const failedTasks: string[] = [];
    const dlqJobs: Array<{
      name: string;
      data: CallbackDlqJobData;
      options: { jobId?: string } | undefined;
    }> = [];
    const processor = new CallbackWorkerProcessor(
      {
        async deliver() {
          throw new Error('consumer still down');
        },
        async markFailed(aiTaskId) {
          failedTasks.push(aiTaskId);
        },
      },
      {
        async add(name, data, options) {
          dlqJobs.push({ name, data, options });
          return null;
        },
      },
      { now: () => 5_000 },
    );

    await expect(processor.process(createJob({ attemptsMade: 2, opts: { attempts: 3 } }))).rejects.toThrow(
      'consumer still down',
    );

    expect(failedTasks).toEqual(['task-callback-1']);
    expect(dlqJobs).toEqual([
      {
        name: 'failed',
        data: {
          ai_task_id: 'task-callback-1',
          failed_at: 5_000,
          reason: 'consumer still down',
          attempts_made: 3,
        },
        options: { jobId: 'callback-dlq-task-callback-1' },
      },
    ]);
  });

  it('writes DLQ when the retry window is expired before max attempts', async () => {
    const failedTasks: string[] = [];
    const dlqJobs: unknown[] = [];
    const processor = new CallbackWorkerProcessor(
      {
        async deliver() {
          throw new Error('timeout');
        },
        async markFailed(aiTaskId) {
          failedTasks.push(aiTaskId);
        },
      },
      {
        async add(name, data, options) {
          dlqJobs.push({ name, data, options });
          return null;
        },
      },
      { retryWindowMs: 1_000, now: () => 3_000 },
    );

    await expect(processor.process(createJob({ attemptsMade: 0, opts: { attempts: 5 } }))).rejects.toThrow(
      'timeout',
    );

    expect(failedTasks).toEqual(['task-callback-1']);
    expect(dlqJobs).toMatchObject([
      {
        name: 'failed',
        data: { ai_task_id: 'task-callback-1', attempts_made: 1 },
      },
    ]);
  });

  it('keeps the callback failure terminal when the Feishu webhook send throws', async () => {
    const failedTasks: string[] = [];
    const dlqJobs: unknown[] = [];
    const warnings: string[] = [];
    const processor = new CallbackWorkerProcessor(
      {
        async deliver() {
          throw new Error('consumer still down');
        },
        async markFailed(aiTaskId) {
          failedTasks.push(aiTaskId);
        },
      },
      {
        async add(name, data, options) {
          dlqJobs.push({ name, data, options });
          return null;
        },
      },
      { now: () => 5_000 },
      new AlertFeishuNotifier(
        {
          MODEL_CALL_FEISHU_ENVIRONMENT: 'test',
          ALERT_FEISHU_ENABLED: true,
          ALERT_FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/bad',
          REASON_MAPPING_FEISHU_TIMEOUT_MS: 5_000,
        },
        {
          async sendText() {
            throw new Error('webhook misconfigured');
          },
        },
        {
          info() {
            return undefined;
          },
          warn(_fields, message) {
            warnings.push(message);
          },
        },
      ),
    );

    await expect(processor.process(createJob({ attemptsMade: 2, opts: { attempts: 3 } }))).rejects.toThrow(
      'consumer still down',
    );

    expect(failedTasks).toEqual(['task-callback-1']);
    expect(dlqJobs).toHaveLength(1);
    expect(warnings).toEqual(['alert.feishu.callback_dlq_failed']);
  });
});
