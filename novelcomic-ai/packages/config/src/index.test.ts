import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AlertFeishuNotifier } from '../../runtime/src/feishu-notifier.js';
import { ModelCallNotifier } from '../../runtime/src/model-call-notifier.js';
import { loadConfig, publicSwitchDump, resolveArtifactStorageProvider, type AppConfig } from './index.js';

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://127.0.0.1:27017',
    REDIS_URL: 'redis://127.0.0.1:6379',
    AUTH_KEY: 'auth-key',
    CONSUMER_WEBHOOK_SECRET: 'whsec',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

describe('novelcomic-ai config', () => {
  it('refuses to start when Mongo, Redis, authKey, or the webhook secret is missing', () => {
    for (const key of ['MONGODB_URI', 'REDIS_URL', 'AUTH_KEY', 'CONSUMER_WEBHOOK_SECRET'] as const) {
      expect(() => loadConfig(baseEnv({ [key]: undefined }))).toThrow(/Invalid novelcomic-ai config/);
      expect(() => loadConfig(baseEnv({ [key]: '   ' }))).toThrow(/Invalid novelcomic-ai config/);
    }
  });

  it('does not start a process when MONGODB_URI is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nc-ai-config-'));
    const envFile = path.join(dir, 'empty.env');
    const checker = path.join(dir, 'start-check.mjs');
    writeFileSync(envFile, '');
    writeFileSync(
      checker,
      "import { pathToFileURL } from 'node:url';\nawait import(pathToFileURL(process.argv[2]).href);\n",
    );
    const configModule = path.join(packageRoot, 'packages/config/src/index.ts');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', checker, configModule],
      {
        cwd: packageRoot,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NODE_ENV: 'production',
          REDIS_URL: 'redis://127.0.0.1:6379',
          AUTH_KEY: 'auth-key',
          CONSUMER_WEBHOOK_SECRET: 'whsec',
          DOTENV_CONFIG_PATH: envFile,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/Invalid novelcomic-ai config/);
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/MONGODB_URI/);
  });

  it('dumps unused switches as on or off and leaves secrets out', () => {
    const parsed = loadConfig(
      baseEnv({
        ENABLE_BULL_BOARD: 'true',
        AUTH_KEY: 'super-secret',
        CONSUMER_WEBHOOK_SECRET: 'whsec',
      }),
    );
    const dumped = publicSwitchDump(parsed);
    expect(dumped).toEqual({
      ENABLE_BULL_BOARD: true,
      CONFIG_LOADER_ENABLED: false,
      ALERT_FEISHU_ENABLED: false,
      MODEL_CALL_FEISHU_ENABLED: false,
    });
    expect(JSON.stringify(dumped)).not.toContain('super-secret');
    expect(JSON.stringify(dumped)).not.toContain('whsec');
  });

  it('enables switches only for the string true and keeps Feishu off by default', () => {
    const flags = [
      'ENABLE_BULL_BOARD',
      'ALERT_FEISHU_ENABLED',
      'MODEL_CALL_FEISHU_ENABLED',
      'CONFIG_LOADER_ENABLED',
    ] as const;
    const defaults = loadConfig(baseEnv());
    for (const flag of flags) {
      expect(defaults[flag]).toBe(false);
      for (const raw of ['false', 'FALSE', '1', 'yes', 'True', ' true ']) {
        expect(loadConfig(baseEnv({ [flag]: raw }))[flag]).toBe(false);
      }
      expect(loadConfig(baseEnv({ [flag]: 'true' }))[flag]).toBe(true);
    }
  });

  it('does not send Feishu notifications when the webhook is empty', async () => {
    const parsed = loadConfig(
      baseEnv({
        MODEL_CALL_FEISHU_ENABLED: 'true',
        MODEL_CALL_FEISHU_WEBHOOK_URL: '',
        ALERT_FEISHU_ENABLED: 'true',
        ALERT_FEISHU_WEBHOOK_URL: '   ',
      }),
    );
    expect(parsed.MODEL_CALL_FEISHU_WEBHOOK_URL).toBeUndefined();
    expect(parsed.ALERT_FEISHU_WEBHOOK_URL).toBeUndefined();

    const sent: string[] = [];
    const client = {
      async sendText(message: { text: string }) {
        sent.push(message.text);
      },
    };
    const modelConfig: Pick<
      AppConfig,
      'MODEL_CALL_FEISHU_ENABLED' | 'MODEL_CALL_FEISHU_WEBHOOK_URL' | 'MODEL_CALL_FEISHU_ENVIRONMENT'
    > = parsed;
    await new ModelCallNotifier(modelConfig, repository(), client).notifyOnce('task-1');
    await new AlertFeishuNotifier(parsed, client).notifyCallbackFailed({
      aiTaskId: 'task-1',
      reason: 'timeout',
      attemptsMade: 3,
    });

    expect(sent).toEqual([]);
  });

  it('uses cos only when the five COS fields are present', () => {
    const cosFields = {
      COS_SECRET_ID: 'id',
      COS_SECRET_KEY: 'key',
      COS_REGION: 'ap-guangzhou',
      COS_BUCKET: 'bucket',
      COS_CDN_DOMAIN: 'https://cdn.example.com',
    };
    expect(resolveArtifactStorageProvider(baseEnv())).toBe('pass_through');
    expect(resolveArtifactStorageProvider(baseEnv({ ...cosFields, COS_CDN_DOMAIN: '  ' }))).toBe('pass_through');
    expect(loadConfig(baseEnv({ ARTIFACT_STORAGE_PROVIDER: 's3' })).ARTIFACT_STORAGE_PROVIDER).toBe('s3');
    expect(resolveArtifactStorageProvider(baseEnv(cosFields))).toBe('cos');
    expect(loadConfig(baseEnv({ ...cosFields, ARTIFACT_STORAGE_PROVIDER: 'pass_through' })).ARTIFACT_STORAGE_PROVIDER).toBe(
      'cos',
    );
  });
});

function repository() {
  return {
    async claimModelCallNotification() {
      return true;
    },
    async markModelCallNotificationFailed() {},
    async markModelCallNotificationSent() {},
    async requireByAiTaskId() {
      throw new Error('webhook was empty, so the task should not be loaded');
    },
  };
}
