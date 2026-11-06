import type { CoreProviderResult, JsonObject, JsonValue } from '../types.js';
import type { KieResponseBody } from './kie_client.js';

const SUCCESS_STATES = new Set(['success', 'succeeded', 'completed', 'complete', 'done', 'finished']);
const FAILURE_STATES = new Set(['fail', 'failed', 'error', 'errored', 'cancelled', 'canceled']);
const PROCESSING_STATES = new Set(['waiting', 'queued', 'queuing', 'pending', 'running', 'generating', 'processing']);

export function normalizeKieResult(raw: KieResponseBody): CoreProviderResult {
  const expanded = expandKieResultJson(raw);
  const state = readFirstString(expanded, [
    'state',
    'status',
    'data.state',
    'data.status',
    'data.taskStatus',
    'data.recordInfo.state',
    'data.recordInfo.status',
  ])?.toLowerCase();
  const code = readFirstNumber(expanded, ['code', 'data.code']);

  if ((code !== undefined && code !== 0 && code !== 200) || (state && FAILURE_STATES.has(state))) {
    return {
      status: 'failed',
      error: {
        code: state ?? String(code ?? 'KIE_PROVIDER_ERROR'),
        message: readErrorMessage(expanded),
        details: raw,
      },
      raw,
    };
  }

  if (state && PROCESSING_STATES.has(state)) {
    return { status: 'processing', raw };
  }

  const outputs = collectOutputs(expanded);
  if (state ? SUCCESS_STATES.has(state) : Object.keys(outputs).length > 0) {
    const result: CoreProviderResult = { status: 'succeeded', raw };
    if (Object.keys(outputs).length > 0) {
      result.outputs = outputs;
    }
    return result;
  }

  return { status: 'processing', raw };
}

function collectOutputs(value: unknown): JsonObject {
  const mediaUrls = collectUrlStrings(value);
  const text = readFirstString(value, [
    'text',
    'result',
    'message',
    'data.text',
    'data.result',
    'data.output',
    'data.resultText',
    'data.recordInfo.text',
    'data.recordInfo.result',
  ]);
  const outputs: JsonObject = {};

  if (mediaUrls.length > 0) {
    outputs.media_urls = mediaUrls;
  }
  if (text && !looksLikeUrl(text)) {
    outputs.text = text;
  }

  return outputs;
}

function expandKieResultJson(value: KieResponseBody): KieResponseBody {
  if (!isRecord(value)) return value;
  const clone = structuredClone(value) as Record<string, JsonValue>;
  const data = clone.data;

  if (isRecord(data) && typeof data.resultJson === 'string') {
    const parsed = parseJson(data.resultJson);
    if (parsed !== undefined) {
      data.parsedResultJson = parsed;
    }
  }

  return clone as KieResponseBody;
}

function readErrorMessage(value: unknown): string {
  return (
    readFirstString(value, [
      'msg',
      'message',
      'error',
      'error.message',
      'data.msg',
      'data.message',
      'data.error',
      'data.error.message',
    ]) ?? 'KIE provider returned a failed result'
  );
}

function collectUrlStrings(value: unknown): string[] {
  const urls = new Set<string>();
  visit(value, (candidate) => {
    if (typeof candidate === 'string' && looksLikeUrl(candidate)) {
      urls.add(candidate);
    }
  });
  return [...urls];
}

function visit(value: unknown, callback: (value: unknown) => void): void {
  callback(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, callback);
    }
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      visit(item, callback);
    }
  }
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value);
}

function parseJson(value: string): JsonValue | undefined {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return undefined;
  }
}

function readFirstString(value: unknown, paths: readonly string[]): string | undefined {
  for (const path of paths) {
    const found = readPath(value, path.split('.'));
    if (typeof found === 'string' && found.trim()) {
      return found;
    }
  }
  return undefined;
}

function readFirstNumber(value: unknown, paths: readonly string[]): number | undefined {
  for (const path of paths) {
    const found = readPath(value, path.split('.'));
    if (typeof found === 'number' && Number.isFinite(found)) {
      return found;
    }
  }
  return undefined;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let cursor = value;
  for (const segment of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
