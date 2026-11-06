import type { SmokeJobInput, SmokeJobResult } from '@novelcomic/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
export declare const QUEUE_PREFIX = "novelcomic";
export declare const SMOKE_QUEUE_NAME = "smoke";
export declare const PROVIDER_EXECUTION_QUEUE_NAME = "provider-execution";
export declare const MEDIA_FACE_VERIFICATION_QUEUE_NAME = "media-face-verification";
export declare const ARTIFACT_PROCESSING_QUEUE_NAME = "artifact-processing";
export declare const CONSUMER_CALLBACK_QUEUE_NAME = "consumer-callback";
export declare const CALLBACK_DLQ_QUEUE_NAME = "consumer-callback-dlq";
export declare const QUEUE_NAMES: {
    readonly providerExecution: "provider-execution";
    readonly artifactProcessing: "artifact-processing";
    readonly consumerCallback: "consumer-callback";
    readonly callbackDlq: "consumer-callback-dlq";
    readonly mediaFaceVerification: "media-face-verification";
};
export type MediaFaceVerificationJob = {
    provider: 'byteplus';
    media_url: string;
    asset_id: string;
    enqueued_at: number;
    attempts_started_at?: number;
};
export type ConsumerCallbackJob = {
    ai_task_id: string;
    enqueued_at: number;
};
export type CallbackDlqJob = {
    ai_task_id: string;
    failed_at: number;
    reason: string;
    attempts_made: number;
};
export type ArtifactProcessingJob = {
    ai_task_id: string;
    enqueued_at: number;
};
export { DEFAULT_REDIS_TTL_SECONDS, DEFAULT_WORKER_HEARTBEAT_PREFIX, WORKER_HEARTBEAT_INTERVAL_MS, WORKER_HEARTBEAT_NAME, readWorkerHeartbeat, redisDefaultTtlSeconds, startWorkerHeartbeat, workerReadyzKey, writeWorkerHeartbeat, } from './heartbeat.js';
export declare function createRedisConnection(): Redis;
export declare function createSmokeQueue(connection: Redis): Queue<SmokeJobInput, SmokeJobResult>;
export declare function createMediaFaceVerificationQueue(connection: Redis): Queue<MediaFaceVerificationJob>;
export declare function createArtifactProcessingQueue(connection: Redis): Queue<ArtifactProcessingJob>;
export declare function createConsumerCallbackQueue(connection: Redis): Queue<ConsumerCallbackJob>;
export declare function createCallbackDlqQueue(connection: Redis): Queue<CallbackDlqJob>;
