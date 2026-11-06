import { config } from '@novelcomic/config';
import type { SmokeJobInput, SmokeJobResult } from '@novelcomic/contracts';
import { CallbackDeliveryRepository, createMongoContext, ensureMongoIndexes, TaskRepository } from '@novelcomic/db';
import { logger } from '@novelcomic/observability';
import { ARTIFACT_PROCESSING_QUEUE_NAME, CONSUMER_CALLBACK_QUEUE_NAME, createArtifactProcessingQueue, createCallbackDlqQueue, createConsumerCallbackQueue, createRedisConnection, MEDIA_FACE_VERIFICATION_QUEUE_NAME, QUEUE_PREFIX, SMOKE_QUEUE_NAME, startWorkerHeartbeat, type ArtifactProcessingJob, type ConsumerCallbackJob, type MediaFaceVerificationJob } from '@novelcomic/queues';
import { AlertFeishuNotifier, ArtifactWorkerProcessor, CallbackWorkerProcessor, ConsumerCallbackService, FeishuWebhookClient, MediaFaceVerificationWorkerProcessor, ModelCallNotifier, processSmokeJob, ProviderWorkerProcessor, type BytePlusAssetClient, type MediaFaceVerificationRepository, type MediaVerificationStatus, type ProviderExecutionJob } from '@novelcomic/runtime';
import { createArtifactUploader, DefaultArtifactStore } from '@novelcomic/storage';
import { Queue, Worker } from 'bullmq';
const redis = createRedisConnection(); await redis.ping();
const workerHeartbeat = startWorkerHeartbeat(redis, { prefix: QUEUE_PREFIX });
const mongo = await createMongoContext();
await ensureMongoIndexes(mongo);
logger.info({ db: config.MONGODB_DB }, 'mongo indexes ready');
const worker = new Worker<SmokeJobInput, SmokeJobResult>(SMOKE_QUEUE_NAME, async (job) => processSmokeJob(job.data), { connection: redis, prefix: QUEUE_PREFIX });
const providerTaskRepository = new TaskRepository(mongo.db);
const providerExecutionQueue = new Queue<ProviderExecutionJob>('provider-execution', { connection: redis, prefix: QUEUE_PREFIX });
const artifactProcessingQueue = createArtifactProcessingQueue(redis);
const consumerCallbackQueue = createConsumerCallbackQueue(redis);
const callbackDlqQueue = createCallbackDlqQueue(redis);
const modelCallNotifier = new ModelCallNotifier(
  config,
  providerTaskRepository,
  new FeishuWebhookClient({
    enabled: config.MODEL_CALL_FEISHU_ENABLED,
    webhookUrl: config.MODEL_CALL_FEISHU_WEBHOOK_URL,
    secret: config.MODEL_CALL_FEISHU_SECRET,
    timeoutMs: config.MODEL_CALL_FEISHU_TIMEOUT_MS,
    logger: logger.child({ component: 'model-call-feishu' }),
  }),
  logger.child({ component: 'model-call-notifier' }),
);
const alertNotifier = new AlertFeishuNotifier(
  config,
  new FeishuWebhookClient({
    enabled: config.ALERT_FEISHU_ENABLED,
    webhookUrl: config.ALERT_FEISHU_WEBHOOK_URL,
    secret: config.ALERT_FEISHU_SECRET,
    timeoutMs: config.ALERT_FEISHU_TIMEOUT_MS,
    logger: logger.child({ component: 'alert-feishu' }),
  }),
  logger.child({ component: 'alert-feishu' }),
);
const providerProcessor = new ProviderWorkerProcessor(
  providerTaskRepository,
  logger,
  providerExecutionQueue,
  undefined,
  artifactProcessingQueue,
);
const providerWorker = new Worker<ProviderExecutionJob>(
  'provider-execution',
  async (job) => providerProcessor.process(job.data),
  { connection: redis, prefix: QUEUE_PREFIX },
);
const artifactProcessor = new ArtifactWorkerProcessor(
  providerTaskRepository,
  new DefaultArtifactStore(createArtifactUploader(config), { ARTIFACT_BASE_URL: config.ARTIFACT_BASE_URL }),
  consumerCallbackQueue,
  modelCallNotifier,
);
const artifactWorker = new Worker<ArtifactProcessingJob>(
  ARTIFACT_PROCESSING_QUEUE_NAME,
  async (job) => artifactProcessor.process(job.data),
  { connection: redis, prefix: QUEUE_PREFIX },
);
const callbackProcessor = new CallbackWorkerProcessor(
  new ConsumerCallbackService(
    providerTaskRepository,
    { consumerWebhookSecret: config.CONSUMER_WEBHOOK_SECRET },
    new CallbackDeliveryRepository(mongo.db),
  ),
  callbackDlqQueue,
  {},
  alertNotifier,
);
const callbackWorker = new Worker<ConsumerCallbackJob>(
  CONSUMER_CALLBACK_QUEUE_NAME,
  async (job) => callbackProcessor.process(job),
  { connection: redis, prefix: QUEUE_PREFIX },
);
const repository: MediaFaceVerificationRepository = {
  async findByMediaUrl(mediaUrl) {
    const record = await mongo.db.collection('media_face_verifications').findOne({ 'media.url': mediaUrl });
    const state = record?.face_providers?.byteplus;
    if (!state) return null;
    const output: { asset_id?: string; verification_status?: MediaVerificationStatus; sync_status?: string } = {};
    if (typeof state.asset_id === 'string') output.asset_id = state.asset_id;
    if (typeof state.verification_status === 'string') {
      output.verification_status = state.verification_status as MediaVerificationStatus;
    }
    if (typeof state.sync_status === 'string') output.sync_status = state.sync_status;
    return output;
  },
  async markProviderState(input) {
    await mongo.db.collection('media_face_verifications').updateOne(
      { 'media.url': input.media_url, [`face_providers.${input.provider}.asset_id`]: { $exists: true } },
      {
        $set: {
          [`face_providers.${input.provider}.verification_status`]: input.verification_status,
          [`face_providers.${input.provider}.sync_status`]: input.sync_status,
          [`face_providers.${input.provider}.last_sync_error`]: input.last_sync_error ?? null,
          [`face_providers.${input.provider}.updated_at`]: new Date(),
          updated_at: new Date(),
        },
      },
    );
  },
};
const bytePlusClient: BytePlusAssetClient = {
  async getAsset(assetId) {
    if (!config.BYTEPLUS_GET_ASSET_URL) return { status: 'Processing' };
    const response = await fetch(config.BYTEPLUS_GET_ASSET_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.BYTEPLUS_API_KEY ? { Authorization: `Bearer ${config.BYTEPLUS_API_KEY}` } : {}),
      },
      body: JSON.stringify({ asset_id: assetId }),
    });
    if (!response.ok) return { status: 'Failed', error: `HTTP ${response.status}` };
    const payload = await response.json() as { status?: string; data?: { status?: string }; error?: string };
    const status = payload.data?.status ?? payload.status;
    if (status === 'Active' || status === 'Failed' || status === 'Pending' || status === 'Processing') {
      return payload.error ? { status, error: payload.error } : { status };
    }
    return { status: 'Processing' };
  },
};
const mediaFaceProcessor = new MediaFaceVerificationWorkerProcessor(repository, bytePlusClient);
const mediaFaceWorker = new Worker<MediaFaceVerificationJob>(
  MEDIA_FACE_VERIFICATION_QUEUE_NAME,
  async (job) => mediaFaceProcessor.process(job.data),
  { connection: redis, prefix: QUEUE_PREFIX },
);
worker.on('completed', (job) => logger.info({ jobId: job.id }, 'smoke job completed'));
worker.on('failed', (job, error) => logger.error({ jobId: job?.id, error }, 'smoke job failed'));
providerWorker.on('completed', (job) => logger.info({ jobId: job.id, aiTaskId: job.data.ai_task_id }, 'provider task loaded'));
providerWorker.on('failed', (job, error) => logger.error({ jobId: job?.id, aiTaskId: job?.data.ai_task_id, error }, 'provider task load failed'));
artifactWorker.on('completed', (job) => logger.info({ jobId: job.id, aiTaskId: job.data.ai_task_id }, 'artifact task completed'));
artifactWorker.on('failed', (job, error) => logger.error({ jobId: job?.id, aiTaskId: job?.data.ai_task_id, error }, 'artifact task failed'));
callbackWorker.on('completed', (job) => logger.info({ jobId: job.id, aiTaskId: job.data.ai_task_id }, 'consumer callback completed'));
callbackWorker.on('failed', (job, error) => logger.error({ jobId: job?.id, aiTaskId: job?.data.ai_task_id, error }, 'consumer callback failed'));
mediaFaceWorker.on('completed', (job) => logger.info({ jobId: job.id }, 'media face verification job completed'));
mediaFaceWorker.on('failed', (job, error) => logger.error({ jobId: job?.id, error }, 'media face verification job failed'));
logger.info({ queue: SMOKE_QUEUE_NAME }, 'novelcomic worker started');
async function shutdown(signal: string): Promise<void> { workerHeartbeat.stop(); logger.info({ signal }, 'shutting down worker'); await worker.close(); await providerWorker.close(); await providerExecutionQueue.close(); await artifactWorker.close(); await artifactProcessingQueue.close(); await callbackWorker.close(); await consumerCallbackQueue.close(); await callbackDlqQueue.close(); await mediaFaceWorker.close(); await mongo.client.close(); await redis.quit(); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void shutdown(signal));
