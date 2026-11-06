/**
 * Replay consumer callbacks through the official BullMQ queue.
 * Does not write node state. The worker signs and POSTs the webhook.
 *
 *   CONSUMER_HEALTH_URL=http://127.0.0.1:8001/health \
 *     pnpm exec tsx scripts/replay-consumer-callbacks.ts \
 *     task_xxx task_yyy
 */
const CONSUMER_CALLBACK_QUEUE_NAME = 'consumer-callback';

export interface ConsumerCallbackReplayQueue {
  add(
    name: string,
    data: { ai_task_id: string; enqueued_at: number },
    options?: { attempts?: number; jobId?: string },
  ): Promise<{ id?: string | number | null }>;
}

export function parseAiTaskIds(argv: string[]): string[] {
  return argv.filter((value) => value.startsWith('task_'));
}

export function callbackReplayJobId(aiTaskId: string, now: number): string {
  return `callback-replay-${aiTaskId}-${now}`;
}

export function responseLooksHealthy(ok: boolean, body: string, contentType: string | null): boolean {
  if (!ok) {
    return false;
  }
  return !body.includes('502') && (body.includes('ok') || contentType?.includes('json') === true);
}

export async function consumerHealthy(
  healthUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(8_000) });
    const body = await response.text();
    return responseLooksHealthy(response.ok, body, response.headers.get('content-type'));
  } catch {
    return false;
  }
}

export async function waitForConsumer(options: {
  healthUrl: string;
  waitMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  check?: () => Promise<boolean>;
}): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const check = options.check ?? (() => consumerHealthy(options.healthUrl));
  const deadline = now() + options.waitMs;
  while (now() <= deadline) {
    if (await check()) {
      console.log(`consumer health ok: ${options.healthUrl}`);
      return;
    }
    const remain = Math.max(0, deadline - now());
    console.log(`consumer still down (${options.healthUrl}), retry in ${options.pollMs}ms, remain=${remain}ms`);
    if (remain === 0) {
      break;
    }
    await sleep(Math.min(options.pollMs, remain));
  }
  throw new Error(`consumer health check failed: ${options.healthUrl}`);
}

export async function enqueueConsumerCallbackReplays(
  queue: ConsumerCallbackReplayQueue,
  taskIds: string[],
  now: () => number = Date.now,
): Promise<string[]> {
  const jobIds: string[] = [];
  for (const aiTaskId of taskIds) {
    const timestamp = now();
    const jobId = callbackReplayJobId(aiTaskId, timestamp);
    const job = await queue.add(
      'deliver',
      { ai_task_id: aiTaskId, enqueued_at: timestamp },
      { attempts: 5, jobId },
    );
    const recordedId = job.id == null ? jobId : String(job.id);
    jobIds.push(recordedId);
    console.log(`enqueued ${aiTaskId} job_id=${recordedId}`);
  }
  return jobIds;
}

function isCliEntry(): boolean {
  const entry = process.argv[1] ?? '';
  return entry.endsWith('replay-consumer-callbacks.ts') || entry.endsWith('replay-consumer-callbacks.js');
}

async function main(): Promise<void> {
  const taskIds = parseAiTaskIds(process.argv.slice(2));
  if (taskIds.length === 0) {
    throw new Error('ai_task_id is required');
  }
  const healthUrl = process.env.CONSUMER_HEALTH_URL ?? 'http://127.0.0.1:8001/health';
  const waitMs = Number(process.env.WAIT_FOR_HEALTH_MS ?? '60000');
  const pollMs = Number(process.env.HEALTH_POLL_MS ?? '5000');
  console.log(`replay ${taskIds.length} callbacks via ${CONSUMER_CALLBACK_QUEUE_NAME} queue`);
  await waitForConsumer({ healthUrl, pollMs, waitMs });

  const { createConsumerCallbackQueue, createRedisConnection } = await import('../packages/queues/src/index.ts');
  const connection = createRedisConnection();
  const queue = createConsumerCallbackQueue(connection);
  try {
    await enqueueConsumerCallbackReplays(queue, taskIds);
  } finally {
    await queue.close();
    await connection.quit();
  }
  console.log('done');
}

if (isCliEntry()) {
  await main();
}
