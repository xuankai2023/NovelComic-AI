import { config } from '@novelcomic/config';
import { smokeJobInputSchema } from '@novelcomic/contracts';
import { createMongoContext, ensureMongoIndexes } from '@novelcomic/db';
import { logger } from '@novelcomic/observability';
import {
  createArtifactProcessingQueue,
  createMediaFaceVerificationQueue,
  createRedisConnection,
  createSmokeQueue,
} from '@novelcomic/queues';
import type { ProviderExecutionJob } from '@novelcomic/runtime';
import cors from '@fastify/cors';
import { Queue } from 'bullmq';
import Fastify from 'fastify';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { registerAuthKeyHook } from './plugins/auth-key.js';
import { registerBullBoard } from './plugins/bull-board.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerProviderWebhookRoutes } from './routes/provider-webhooks.js';
import { registerTaskRoutes } from './routes/tasks.js';
const app = Fastify({ loggerInstance: logger });
const COS_PRESIGN_EXPIRES_IN_SECONDS = 900;
const corsOrigins = config.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);
const allowedCorsOrigins = new Set(corsOrigins);
await app.register(cors, {
  origin: (origin, callback) => {
    if (!origin || allowedCorsOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
});
const binaryBodyParser = (_request: unknown, body: Buffer, done: (error: Error | null, body?: Buffer) => void) => {
  done(null, body);
};
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, binaryBodyParser);
app.addContentTypeParser('application/pdf', { parseAs: 'buffer' }, binaryBodyParser);
app.addContentTypeParser('text/markdown', { parseAs: 'buffer' }, binaryBodyParser);
app.addContentTypeParser(/^image\/.*/, { parseAs: 'buffer' }, binaryBodyParser);
app.addContentTypeParser(/^video\/.*/, { parseAs: 'buffer' }, binaryBodyParser);
app.addContentTypeParser(/^audio\/.*/, { parseAs: 'buffer' }, binaryBodyParser);
const mongo = await createMongoContext();
await ensureMongoIndexes(mongo);
logger.info({ db: config.MONGODB_DB }, 'mongo indexes ready');
const redis = createRedisConnection();
const smokeQueue = createSmokeQueue(redis);
const mediaFaceVerificationQueue = createMediaFaceVerificationQueue(redis);
const providerExecutionQueue = new Queue<ProviderExecutionJob>('provider-execution', {
  connection: redis,
  prefix: 'novelcomic',
});
const artifactProcessingQueue = createArtifactProcessingQueue(redis);
type ApiEnvelope<T> = { code: 200; msg: 'ok'; data: T };
type PresignRequest = {
  filename?: string;
  content_type?: string;
  file_type?: 'image' | 'video' | 'audio' | 'file' | string | null;
};
type PresignResponse = {
  presigned_url: string;
  object_key: string;
  cdn_url: string;
  expires_in: number;
};
type MediaFaceVerificationEnqueueRequest = {
  provider?: 'byteplus' | string;
  items?: Array<{ media_url?: string; asset_id?: string }>;
};
const success = <T>(data: T): ApiEnvelope<T> => ({ code: 200, msg: 'ok', data });
const safeFilename = (filename: string): string => {
  const baseName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  return baseName || 'upload.bin';
};
const objectPrefixForFileType = (fileType: string | null | undefined): string => {
  if (fileType === 'image') return 'images';
  if (fileType === 'video') return 'videos';
  if (fileType === 'audio') return 'audios';
  return 'uploads';
};
const buildCosObjectKey = (filename: string, fileType: string | null | undefined): string => {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const randomId = randomBytes(8).toString('hex');
  return `${objectPrefixForFileType(fileType)}/${year}/${month}/${Date.now()}-${randomId}-${safeFilename(filename)}`;
};
const encodeObjectKey = (objectKey: string): string => Buffer.from(objectKey, 'utf8').toString('base64url');
const decodeObjectKey = (encodedKey: string): string => Buffer.from(encodedKey, 'base64url').toString('utf8');
const signUploadTarget = (encodedKey: string, expiresAt: number, contentType: string): string =>
  createHmac('sha256', config.COS_PRESIGN_SECRET)
    .update(`${encodedKey}.${expiresAt}.${contentType}`)
    .digest('hex');
const getPublicApiUrl = (request: {
  protocol: string;
  headers: { host?: string | undefined; 'x-forwarded-proto'?: string | string[] | undefined };
}) => {
  if (config.PUBLIC_API_URL) return config.PUBLIC_API_URL.replace(/\/+$/, '');
  const forwardedProto = request.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return `${protocol ?? request.protocol}://${request.headers.host ?? `localhost:${config.API_PORT}`}`;
};
const resolveUploadPath = (objectKey: string): string => path.resolve(config.UPLOAD_DIR, objectKey);
const verifyUploadToken = (encodedKey: string, expiresAt: number, contentType: string, token: string): boolean => {
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
  return signUploadTarget(encodedKey, expiresAt, contentType) === token;
};
registerAuthKeyHook(app, { security: { authKey: config.AUTH_KEY } });
await registerBullBoard(app, config.ENABLE_BULL_BOARD);
registerHealthRoutes(app, { mongo, redis });
await registerTaskRoutes(app, { db: mongo.db, providerExecutionQueue });
await registerProviderWebhookRoutes(app, {
  db: mongo.db,
  providerExecutionQueue,
  artifactProcessingQueue,
});
app.post<{ Body: PresignRequest }>('/api/v2/cos/presign', async (request, reply) => {
  const filename = request.body?.filename?.trim();
  const contentType = request.body?.content_type?.trim();
  if (!filename || !contentType) {
    return reply.code(400).send({ code: 400, msg: 'filename and content_type are required', data: null });
  }
  const objectKey = buildCosObjectKey(filename, request.body?.file_type);
  const encodedKey = encodeObjectKey(objectKey);
  const expiresAt = Math.floor(Date.now() / 1000) + COS_PRESIGN_EXPIRES_IN_SECONDS;
  const token = signUploadTarget(encodedKey, expiresAt, contentType);
  const baseUrl = getPublicApiUrl(request);
  return success<PresignResponse>({
    presigned_url: `${baseUrl}/api/v2/cos/upload/${encodedKey}?expires=${expiresAt}&content_type=${encodeURIComponent(contentType)}&token=${token}`,
    object_key: objectKey,
    cdn_url: `${baseUrl}/api/v2/cos/object/${encodedKey}`,
    expires_in: COS_PRESIGN_EXPIRES_IN_SECONDS,
  });
});
app.put<{ Params: { encodedKey: string }; Querystring: { expires?: string; content_type?: string; token?: string } }>(
  '/api/v2/cos/upload/:encodedKey',
  async (request, reply) => {
    const contentType = request.query.content_type ?? request.headers['content-type'] ?? 'application/octet-stream';
    const expiresAt = Number(request.query.expires);
    const token = request.query.token ?? '';
    if (!verifyUploadToken(request.params.encodedKey, expiresAt, contentType, token)) {
      return reply.code(403).send({ code: 403, msg: 'invalid or expired upload token', data: null });
    }
    const objectKey = decodeObjectKey(request.params.encodedKey);
    const uploadPath = resolveUploadPath(objectKey);
    await mkdir(path.dirname(uploadPath), { recursive: true });
    await writeFile(uploadPath, Buffer.isBuffer(request.body) ? request.body : Buffer.from([]));
    return reply.code(204).send();
  },
);
app.get<{ Params: { encodedKey: string } }>('/api/v2/cos/object/:encodedKey', async (request, reply) => {
  try {
    const objectKey = decodeObjectKey(request.params.encodedKey);
    const file = await readFile(resolveUploadPath(objectKey));
    return reply.type('application/octet-stream').send(file);
  } catch {
    return reply.code(404).send({ code: 404, msg: 'object not found', data: null });
  }
});
app.post('/v1/smoke/jobs', async (request, reply) => {
  const input = smokeJobInputSchema.parse(request.body ?? {});
  const job = await smokeQueue.add('smoke', input, { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } });
  return reply.code(202).send({ id: job.id, state: 'waiting' });
});
app.post<{ Body: MediaFaceVerificationEnqueueRequest }>('/v1/media-face-verifications/enqueue', async (request, reply) => {
  if (request.body?.provider !== 'byteplus' || !Array.isArray(request.body.items)) {
    return reply.code(400).send({ code: 400, msg: 'provider and items are required', data: null });
  }
  const results: Array<{ media_url: string; status: 'queued' | 'not_found' | 'invalid' }> = [];
  for (const item of request.body.items) {
    const mediaUrl = item.media_url?.trim() ?? '';
    const assetId = item.asset_id?.trim() ?? '';
    if (!mediaUrl || !assetId) {
      results.push({ media_url: mediaUrl, status: 'invalid' });
      continue;
    }
    const record = await mongo.db.collection('media_face_verifications').findOne({
      'media.url': mediaUrl,
      'face_providers.byteplus.asset_id': assetId,
    });
    if (!record) {
      results.push({ media_url: mediaUrl, status: 'not_found' });
      continue;
    }
    await mediaFaceVerificationQueue.add(
      'poll',
      { provider: 'byteplus', media_url: mediaUrl, asset_id: assetId, enqueued_at: Date.now() },
      { jobId: `media-face-${assetId}` },
    );
    results.push({ media_url: mediaUrl, status: 'queued' });
  }
  return reply.code(202).send(success({ items: results }));
});
app.get<{ Params: { id: string } }>('/v1/smoke/jobs/:id', async (request, reply) => {
  const job = await smokeQueue.getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: 'job_not_found' });
  return { id: job.id, state: await job.getState(), data: job.data, result: job.returnvalue ?? null, failedReason: job.failedReason || null };
});
async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down'); await app.close(); await smokeQueue.close(); await mediaFaceVerificationQueue.close(); await providerExecutionQueue.close(); await artifactProcessingQueue.close(); await redis.quit(); await mongo.client.close();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void shutdown(signal));
await app.listen({ host: config.API_HOST, port: config.API_PORT });
