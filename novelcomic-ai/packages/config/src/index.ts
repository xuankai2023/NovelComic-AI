import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const defaultEnvPath = fileURLToPath(new URL('../../../.env.local', import.meta.url));
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? defaultEnvPath });

function enabledFlag() {
  return z
    .union([z.boolean(), z.string()])
    .default('false')
    .transform((value) => value === true || value === 'true');
}

const optionalUrl = z.preprocess((value) => {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}, z.string().url().optional());

const requiredText = z.string().trim().min(1);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(5151),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  MONGODB_URI: requiredText,
  MONGODB_DB: z.string().default('novelcomic'),
  REDIS_URL: requiredText,
  LOG_LEVEL: z.string().default('info'),
  PUBLIC_API_URL: optionalUrl,
  PROVIDER_WEBHOOK_BASE_URL: optionalUrl,
  AUTH_KEY: requiredText,
  CONSUMER_WEBHOOK_SECRET: requiredText,
  UPLOAD_DIR: z.string().default('uploads'),
  COS_PRESIGN_SECRET: z.string().default('novelcomic-local-upload-secret'),
  ARTIFACT_STORAGE_PROVIDER: z.enum(['cos', 's3', 'pass_through']).default('pass_through'),
  ARTIFACT_BASE_URL: z.string().optional(),
  ARTIFACT_BUCKET: z.string().optional(),
  ARTIFACT_ACCESS_KEY_ID: z.string().optional(),
  ARTIFACT_SECRET_ACCESS_KEY: z.string().optional(),
  S3_DOMAIN: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  COS_SECRET_ID: z.string().optional(),
  COS_SECRET_KEY: z.string().optional(),
  COS_REGION: z.string().optional(),
  COS_BUCKET: z.string().optional(),
  COS_CDN_DOMAIN: z.string().optional(),
  BYTEPLUS_GET_ASSET_URL: optionalUrl,
  BYTEPLUS_API_KEY: z.string().optional(),
  TENCENT_WEBHOOK_SIGN_KEY: z.string().optional(),
  KIE_API_KEY: z.string().min(1).optional(),
  KIE_BASE_URL: z.string().url().default('https://api.kie.ai/api/v1'),
  ENABLE_BULL_BOARD: enabledFlag(),
  CONFIG_LOADER_ENABLED: enabledFlag(),
  MODEL_CALL_FEISHU_ENABLED: enabledFlag(),
  MODEL_CALL_FEISHU_WEBHOOK_URL: optionalUrl,
  MODEL_CALL_FEISHU_SECRET: z.string().optional(),
  MODEL_CALL_FEISHU_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  MODEL_CALL_FEISHU_ENVIRONMENT: z.string().default(process.env.NODE_ENV ?? 'development'),
  ALERT_FEISHU_ENABLED: enabledFlag(),
  ALERT_FEISHU_WEBHOOK_URL: optionalUrl,
  ALERT_FEISHU_SECRET: z.string().optional(),
  ALERT_FEISHU_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  REASON_MAPPING_FEISHU_WEBHOOK_URL: optionalUrl,
  REASON_MAPPING_FEISHU_SECRET: z.string().optional(),
  REASON_MAPPING_FEISHU_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type AppConfig = z.infer<typeof envSchema>;

const COS_STORAGE_KEYS = [
  'COS_SECRET_ID',
  'COS_SECRET_KEY',
  'COS_REGION',
  'COS_BUCKET',
  'COS_CDN_DOMAIN',
] as const;

export function resolveArtifactStorageProvider(
  env: NodeJS.ProcessEnv = process.env,
): 'cos' | 'pass_through' {
  const complete = COS_STORAGE_KEYS.every((key) => {
    const value = env[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
  return complete ? 'cos' : 'pass_through';
}

const PUBLIC_SWITCHES = [
  'ENABLE_BULL_BOARD',
  'CONFIG_LOADER_ENABLED',
  'ALERT_FEISHU_ENABLED',
  'MODEL_CALL_FEISHU_ENABLED',
] as const;

export function publicSwitchDump(config: AppConfig): Record<(typeof PUBLIC_SWITCHES)[number], boolean> {
  return {
    ENABLE_BULL_BOARD: config.ENABLE_BULL_BOARD,
    CONFIG_LOADER_ENABLED: config.CONFIG_LOADER_ENABLED,
    ALERT_FEISHU_ENABLED: config.ALERT_FEISHU_ENABLED,
    MODEL_CALL_FEISHU_ENABLED: config.MODEL_CALL_FEISHU_ENABLED,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid novelcomic-ai config: ${parsed.error.message}`);
  }
  return {
    ...parsed.data,
    ARTIFACT_STORAGE_PROVIDER:
      resolveArtifactStorageProvider(env) === 'cos' ? 'cos' : parsed.data.ARTIFACT_STORAGE_PROVIDER,
  };
}

function applyTestFallbacks(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'test') {
    return;
  }
  if (!env.AUTH_KEY?.trim()) {
    env.AUTH_KEY = 'test-auth-key';
  }
  if (!env.CONSUMER_WEBHOOK_SECRET?.trim()) {
    env.CONSUMER_WEBHOOK_SECRET = 'test-consumer-webhook-secret';
  }
  if (!env.MONGODB_URI?.trim()) {
    env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
  }
  if (!env.REDIS_URL?.trim()) {
    env.REDIS_URL = 'redis://127.0.0.1:6379';
  }
}

applyTestFallbacks(process.env);
export const config: AppConfig = loadConfig();
