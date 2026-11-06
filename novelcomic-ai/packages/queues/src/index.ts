import { config } from '@novelcomic/config';
import type { SmokeJobInput, SmokeJobResult } from '@novelcomic/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
export const QUEUE_PREFIX = 'novelcomic';
export const SMOKE_QUEUE_NAME = 'smoke';
export const PROVIDER_EXECUTION_QUEUE_NAME = 'provider-execution';
export const MEDIA_FACE_VERIFICATION_QUEUE_NAME = 'media-face-verification';
export const ARTIFACT_PROCESSING_QUEUE_NAME = 'artifact-processing';
export const CONSUMER_CALLBACK_QUEUE_NAME = 'consumer-callback';
export const CALLBACK_DLQ_QUEUE_NAME = 'consumer-callback-dlq';
export const QUEUE_NAMES = {
  providerExecution: PROVIDER_EXECUTION_QUEUE_NAME,
  artifactProcessing: ARTIFACT_PROCESSING_QUEUE_NAME,
  consumerCallback: CONSUMER_CALLBACK_QUEUE_NAME,
  callbackDlq: CALLBACK_DLQ_QUEUE_NAME,
  mediaFaceVerification: MEDIA_FACE_VERIFICATION_QUEUE_NAME,
} as const;
export type MediaFaceVerificationJob = {
  provider: 'byteplus';
  media_url: string;
  asset_id: string;
  enqueued_at: number;
  attempts_started_at?: number;
};
export type ConsumerCallbackJob = { ai_task_id: string; enqueued_at: number };
export type CallbackDlqJob = {
  ai_task_id: string;
  failed_at: number;
  reason: string;
  attempts_made: number;
};
export type ArtifactProcessingJob = { ai_task_id: string; enqueued_at: number };
export {
  DEFAULT_REDIS_TTL_SECONDS,
  DEFAULT_WORKER_HEARTBEAT_PREFIX,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_NAME,
  readWorkerHeartbeat,
  redisDefaultTtlSeconds,
  startWorkerHeartbeat,
  workerReadyzKey,
  writeWorkerHeartbeat,
} from './heartbeat.js';
export function createRedisConnection(): Redis { return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }); }
export function createSmokeQueue(connection: Redis): Queue<SmokeJobInput, SmokeJobResult> {
  return new Queue<SmokeJobInput, SmokeJobResult>(SMOKE_QUEUE_NAME, { connection, prefix: QUEUE_PREFIX });
}
export function createMediaFaceVerificationQueue(connection: Redis): Queue<MediaFaceVerificationJob> {
  return new Queue<MediaFaceVerificationJob>(MEDIA_FACE_VERIFICATION_QUEUE_NAME, {
    connection,
    prefix: QUEUE_PREFIX,
  });
}
export function createArtifactProcessingQueue(connection: Redis): Queue<ArtifactProcessingJob> {
  return new Queue<ArtifactProcessingJob>(ARTIFACT_PROCESSING_QUEUE_NAME, {
    connection,
    prefix: QUEUE_PREFIX,
  });
}
export function createConsumerCallbackQueue(connection: Redis): Queue<ConsumerCallbackJob> {
  return new Queue<ConsumerCallbackJob>(CONSUMER_CALLBACK_QUEUE_NAME, {
    connection,
    prefix: QUEUE_PREFIX,
  });
}
export function createCallbackDlqQueue(connection: Redis): Queue<CallbackDlqJob> {
  return new Queue<CallbackDlqJob>(CALLBACK_DLQ_QUEUE_NAME, {
    connection,
    prefix: QUEUE_PREFIX,
  });
}
