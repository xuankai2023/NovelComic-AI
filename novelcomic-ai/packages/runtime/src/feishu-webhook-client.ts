import crypto from 'node:crypto';

const MAX_FEISHU_TEXT_LENGTH = 8_000;

export interface RuntimeLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn?(fields: Record<string, unknown>, message: string): void;
}

export type FeishuWebhookClientOptions = {
  enabled?: boolean | undefined;
  webhookUrl?: string | undefined;
  secret?: string | undefined;
  timeoutMs?: number | undefined;
  logger?: RuntimeLogger | undefined;
};

export type FeishuTextMessage = {
  text: string;
  atAll?: boolean | undefined;
};

export class FeishuWebhookClient {
  public constructor(private readonly options: FeishuWebhookClientOptions) {}

  public async sendText(message: FeishuTextMessage): Promise<void> {
    if (this.options.enabled === false || !this.options.webhookUrl) {
      return;
    }

    const body = buildFeishuTextPayload(message.text, this.options.secret, {
      atAll: message.atAll,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5_000);

    try {
      const response = await fetch(this.options.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const result = await readFeishuResponse(response);

      if (!response.ok) {
        throw new Error(`Feishu webhook failed with status ${response.status}`);
      }
      if (result && typeof result.code === 'number' && result.code !== 0) {
        throw new Error(`Feishu webhook rejected message: code=${result.code} msg=${result.msg ?? ''}`);
      }

      this.options.logger?.info(
        { msg_type: 'text', body_bytes: Buffer.byteLength(JSON.stringify(body)) },
        'feishu.webhook.sent',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function buildFeishuTextPayload(
  text: string,
  secret?: string,
  options: { atAll?: boolean | undefined } = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    msg_type: 'text',
    content: {
      text: truncateFeishuText(options.atAll ? withAtAllMention(text) : text),
    },
  };

  if (!secret) {
    return payload;
  }

  const timestamp = Math.floor(Date.now() / 1_000).toString();
  return {
    timestamp,
    sign: createFeishuSignature(timestamp, secret),
    ...payload,
  };
}

export function createFeishuSignature(timestamp: string, secret: string): string {
  return crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

function withAtAllMention(text: string): string {
  const mention = '<at user_id="all">所有人</at>';
  return text.includes('user_id="all"') ? text : `${mention}\n${text}`;
}

function truncateFeishuText(text: string): string {
  if (text.length <= MAX_FEISHU_TEXT_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_FEISHU_TEXT_LENGTH - 20)}\n...[truncated]`;
}

async function readFeishuResponse(response: Response): Promise<{ code?: number; msg?: string } | undefined> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.code === 'number' ? { code: record.code } : {}),
      ...(typeof record.msg === 'string' ? { msg: record.msg } : {}),
    };
  } catch {
    return undefined;
  }
}
