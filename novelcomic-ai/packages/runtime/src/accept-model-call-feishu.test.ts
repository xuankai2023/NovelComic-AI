import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiTaskDocument } from '@novelcomic/contracts';

import { FeishuWebhookClient, createFeishuSignature } from './feishu-webhook-client.js';
import { ModelCallNotifier, type ModelCallNotifierConfig } from './model-call-notifier.js';

const WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/model-call';

const config: ModelCallNotifierConfig = {
  MODEL_CALL_FEISHU_ENABLED: true,
  MODEL_CALL_FEISHU_WEBHOOK_URL: WEBHOOK_URL,
  MODEL_CALL_FEISHU_ENVIRONMENT: 'test',
};

function task(aiTaskId: string): AiTaskDocument {
  return {
    ai_task_id: aiTaskId,
    status: 'succeeded',
    model_id: 'model-1',
    core_model_id: 'core-1',
    options: {},
    webhook_url: 'https://example.com/webhook',
    created_at: new Date('2026-09-29T00:00:00Z'),
    updated_at: new Date('2026-09-29T00:00:01Z'),
  };
}

function repository() {
  const claimed = new Set<string>();
  const sent: string[] = [];
  const failed: string[] = [];
  return {
    sent,
    failed,
    async claimModelCallNotification(aiTaskId: string) {
      if (claimed.has(aiTaskId)) return false;
      claimed.add(aiTaskId);
      return true;
    },
    async markModelCallNotificationFailed(aiTaskId: string) {
      failed.push(aiTaskId);
    },
    async markModelCallNotificationSent(aiTaskId: string) {
      sent.push(aiTaskId);
    },
    async requireByAiTaskId(aiTaskId: string) {
      return task(aiTaskId);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI model-call Feishu notification', () => {
  it('sends one notification for the same ai_task_id', async () => {
    const texts: string[] = [];
    const repo = repository();
    const notifier = new ModelCallNotifier(config, repo, {
      async sendText(message) {
        texts.push(message.text);
      },
    });

    await notifier.notifyOnce('task-1');
    await notifier.notifyOnce('task-1');

    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('AI任务ID: task-1');
    expect(repo.sent).toEqual(['task-1']);
    expect(repo.failed).toEqual([]);
  });

  it('treats a non-zero Feishu code as failure and does not send that ai_task_id again', async () => {
    const fetches: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetches.push(String(url));
      return new Response(JSON.stringify({ code: 9499, msg: 'rejected' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const repo = repository();
    const notifier = new ModelCallNotifier(
      config,
      repo,
      new FeishuWebhookClient({ enabled: true, webhookUrl: WEBHOOK_URL }),
    );

    await expect(notifier.notifyOnce('task-1')).rejects.toThrow(/code=9499/);
    await notifier.notifyOnce('task-1');

    expect(fetches).toEqual([WEBHOOK_URL]);
    expect(repo.failed).toEqual(['task-1']);
    expect(repo.sent).toEqual([]);
  });
});

describe('Feishu webhook client', () => {
  it('returns without posting when disabled or the url is missing', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return new Response('{}', { status: 200 });
    });

    await new FeishuWebhookClient({ enabled: false, webhookUrl: WEBHOOK_URL }).sendText({ text: 'skip' });
    await new FeishuWebhookClient({ enabled: true }).sendText({ text: 'skip' });

    expect(calls).toEqual([]);
  });

  it('signs the payload when a secret is configured', async () => {
    let rawBody = '';
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      rawBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    });

    await new FeishuWebhookClient({
      enabled: true,
      webhookUrl: WEBHOOK_URL,
      secret: 'top-secret',
    }).sendText({ text: 'hello' });

    const body = JSON.parse(rawBody) as { timestamp: string; sign: string; content: { text: string } };
    expect(body.content.text).toBe('hello');
    expect(body.sign).toBe(createFeishuSignature(body.timestamp, 'top-secret'));
  });

  it('throws when the webhook HTTP status is not successful', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 500 }));
    const client = new FeishuWebhookClient({ enabled: true, webhookUrl: WEBHOOK_URL });
    await expect(client.sendText({ text: 'hello' })).rejects.toThrow(/status 500/);
  });
});
