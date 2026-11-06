/**
 * 按文档里的 14 步验收 AI registry、Provider、Robin、Consumer 映射和产品目录。
 *
 * 用法：
 *   node scripts/accept-ai-model-provider-robin.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORE_MODELS,
  CoreModelNotRegisteredError,
  CoreModelOptionsValidationError,
  CoreProviderNotAvailableError,
  CoreProviderSubmitError,
  DEFAULT_KIE_BASE_URL,
  KieProviderClient,
  KieProviderRequestError,
  getProviderEntry,
  getRemainingRobinProviders,
  listCoreModels,
  registerCoreModel,
  requireCoreModel,
  resolveCoreModelId,
  submitCoreTask,
  validateCoreModelOptions,
  type CoreModelEntity,
  type CoreProviderResult,
  type JsonObject,
} from '@novelcomic/core';
import { TaskRepository } from '../novelcomic-ai/packages/db/src/task-repository.ts';
import { ProviderWorkerProcessor } from '../novelcomic-ai/packages/runtime/src/provider-worker.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AI_ROOT = path.join(ROOT, 'novelcomic-ai');
const MODELS_DIR = path.join(AI_ROOT, 'packages/core/src/models');
const WEBHOOK_URL = 'https://consumer.test/v1/ai/tasks/callback';
const RESULT_MODES = new Set(['sync', 'polling', 'webhook']);

type ProductModel = {
  id: string;
  displayName: string;
  aliases: string[];
  providers: string[];
};

type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

type MappedModel = {
  model_id: string;
  config_name: string;
  mapped: string | null;
  error: string | null;
};

type PublisherModel = {
  config_name: string;
  model_id: string;
  display_name: string;
  brand: string;
};

type FrontendModel = {
  id: string;
  label: string;
  configName?: string;
  brand?: string | null;
};

type Catalog = {
  mappings: MappedModel[];
  publisher: PublisherModel[];
  frontend: FrontendModel[];
  options: {
    model_id: string;
    config_name: string;
    mapped_model_id: string;
    options: JsonObject;
  };
};

type StepResult = {
  step: number;
  name: string;
  ok: boolean;
  detail: string;
};

const productModels = snapshotProductModels();
let catalogPromise: Promise<Catalog> | undefined;

const steps: Array<{ name: string; run: () => Promise<string> | string }> = [
  { name: 'CoreProvider 包含要接入的 Provider', run: checkCoreProvider },
  { name: 'Provider client 能提交一次请求并拿到 request id 或同步结果', run: checkProviderClient },
  { name: 'Provider normalizer 能归一成功、失败、处理中结果', run: checkNormalizer },
  { name: '单个模型文件包含合法 CoreModelEntity 和至少一条 robin_calls', run: checkModelFile },
  { name: '模型被加入 CORE_MODELS', run: checkCoreModelsRegistry },
  { name: 'resolveCoreModelId() 能处理 ID 和 alias', run: checkResolveModelId },
  { name: 'requireCoreModel() 对未注册模型返回稳定错误', run: checkUnregisteredModel },
  { name: 'validateCoreModelOptions() 能按默认 Provider 和钉死 Provider 分别校验参数', run: checkOptionValidation },
  { name: 'submitCoreTask() 能提交默认第一家 Provider', run: checkSubmitDefaultProvider },
  { name: '第一家失败时，Robin 能跳到下一家；钉死 Provider 时不会 fallback', run: checkRobinFallback },
  { name: 'provider worker 能把任务写到 waiting_provider，并记录 Provider request id', run: checkProviderWorker },
  { name: 'Consumer 映射后的 model ID 能被 AI registry 识别', run: checkConsumerMapping },
  { name: 'Consumer 构造的 options 能通过 AI 参数校验', run: checkConsumerOptions },
  { name: 'Publisher/Frontend 目录展示的模型能和 Consumer 映射、AI registry 对齐', run: checkCatalogAlignment },
];

function snapshotProductModels(): ProductModel[] {
  return listCoreModels().map((model) => ({
    id: model.id,
    displayName: model.displayName,
    aliases: [...(model.aliases ?? [])],
    providers: (model.robin_calls ?? []).map((call) => String(call.provider)),
  }));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mappingKey(modelId: string, configName: string): string {
  return `${modelId}\n${configName}`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function assertNamedError(error: unknown, name: string, code: string): void {
  assert(error instanceof Error, `期望 ${name}，实际 ${String(error)}`);
  assert(error.name === name, `期望 ${name}，实际 ${error.name}: ${error.message}`);
  const actualCode = 'code' in error ? String((error as { code: unknown }).code) : '';
  assert(actualCode === code, `${name} 的 code 是 ${actualCode || '空'}，期望 ${code}`);
}

function assertValidationFailure(error: unknown, field: string, code: string): void {
  assert(error instanceof CoreModelOptionsValidationError, `期望参数校验失败，实际 ${formatError(error)}`);
  const matched = error.issues.some((issue) => issue.path === field && issue.code === code);
  assert(matched, `没有找到 ${field}/${code}：${error.message}`);
}

function pythonBin(): string {
  const venv = path.join(ROOT, 'novelcomic-consumer/.venv/bin/python');
  return existsSync(venv) ? venv : 'python3';
}

function kieBaseUrl(): string {
  const configured = process.env.KIE_BASE_URL?.trim();
  return (configured ? configured : DEFAULT_KIE_BASE_URL).replace(/\/+$/, '');
}

function captureFetch(responseBody: unknown, status = 200): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const headerRecord: Record<string, string> = {};
    headers.forEach((value, key) => {
      headerRecord[key] = value;
    });
    let body: unknown;
    if (typeof init?.body === 'string') {
      body = JSON.parse(init.body) as unknown;
    }
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: headerRecord,
      body,
    });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetchImpl, calls };
}

async function withKieFetch<T>(responseBody: unknown, run: (calls: CapturedRequest[]) => Promise<T>): Promise<T> {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.KIE_API_KEY;
  const captured = captureFetch(responseBody);
  process.env.KIE_API_KEY = 'accept-kie-key';
  globalThis.fetch = captured.fetch;
  try {
    return await run(captured.calls);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.KIE_API_KEY;
    } else {
      process.env.KIE_API_KEY = previousKey;
    }
  }
}

class MemoryCollection {
  readonly docs: Array<Record<string, unknown> & { _id: string }> = [];
  private seq = 0;

  async insertOne(document: Record<string, unknown>): Promise<{ insertedId: string }> {
    const stored = structuredClone(document) as Record<string, unknown> & { _id: string };
    stored._id = `mem-${++this.seq}`;
    this.docs.push(stored);
    return { insertedId: stored._id };
  }

  async findOne(query: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const found = this.docs.find((doc) => Object.entries(query).every(([key, value]) => doc[key] === value));
    return found ? structuredClone(found) : null;
  }

  async updateOne(
    query: Record<string, unknown>,
    update: { $set?: Record<string, unknown> },
  ): Promise<{ matchedCount: number }> {
    const found = this.docs.find((doc) => Object.entries(query).every(([key, value]) => doc[key] === value));
    if (!found) {
      return { matchedCount: 0 };
    }
    Object.assign(found, structuredClone(update.$set ?? {}));
    return { matchedCount: 1 };
  }
}

function createRepository(): TaskRepository {
  return new TaskRepository(new MemoryCollection() as never);
}

async function readModelSources(): Promise<Map<string, string>> {
  const fileNames = await readdir(MODELS_DIR);
  const sources = new Map<string, string>();
  for (const fileName of fileNames) {
    if (!fileName.endsWith('.ts')) {
      continue;
    }
    sources.set(fileName, await readFile(path.join(MODELS_DIR, fileName), 'utf8'));
  }
  return sources;
}

function firstCall(model: CoreModelEntity) {
  const call = model.robin_calls?.[0];
  assert(call, `${model.id} 没有 robin_calls`);
  return call;
}

async function checkCoreProvider(): Promise<string> {
  assert(productModels.length > 0, 'CORE_MODELS 是空的，没有要接入的模型');
  const typesSource = await readFile(path.join(AI_ROOT, 'packages/core/src/types.ts'), 'utf8');
  const declaration = typesSource.match(/export type CoreProvider = ([^\n]+)/)?.[1] ?? '';
  assert(declaration.length > 0, 'types.ts 里找不到 CoreProvider');

  const providers = [...new Set(productModels.flatMap((model) => model.providers))];
  assert(providers.length > 0, '已注册模型没有 Provider');
  for (const provider of providers) {
    assert(
      declaration.includes(`'${provider}'`) || declaration.includes(`"${provider}"`),
      `CoreProvider 没有包含 ${provider}：${declaration}`,
    );
    const entry = getProviderEntry(provider);
    assert(entry, `model_constraints.json 没有 Provider ${provider}`);
    assert(typeof entry.retryConfig.maxRetries === 'number', `${provider} 没有 retryConfig`);
  }

  return `CoreProvider 包含 ${providers.join(', ')}；约束里也能查到这些 Provider`;
}

async function checkProviderClient(): Promise<string> {
  const submitted = captureFetch({ code: 200, data: { taskId: 'kie-req-accept-1' } });
  const client = new KieProviderClient({ apiKey: 'accept-kie-key', fetch: submitted.fetch });
  const submittedResult = await client.submit({
    model_id: 'z-image',
    endpoint: '/jobs/createTask',
    options: { prompt: '一只猫' },
    webhook_url: WEBHOOK_URL,
  });
  assert(submitted.calls.length === 1, `提交调用次数是 ${submitted.calls.length}`);
  const request = submitted.calls[0];
  assert(request, '没有捕获到提交请求');
  assert(request.method === 'POST', `提交方法是 ${request.method}`);
  assert(request.url === `${DEFAULT_KIE_BASE_URL}/jobs/createTask`, `提交地址是 ${request.url}`);
  assert(request.headers.authorization === 'Bearer accept-kie-key', '提交请求没有带 Bearer');
  assert(isRecord(request.body), '提交体不是 JSON 对象');
  assert(request.body.model === 'z-image', `提交体 model 是 ${String(request.body.model)}`);
  assert(isRecord(request.body.input) && request.body.input.prompt === '一只猫', '提交体没有 prompt');
  assert(request.body.callBackUrl === WEBHOOK_URL, '提交体没有 callBackUrl');
  assert(submittedResult.provider === 'kie', `返回 provider 是 ${submittedResult.provider}`);
  assert(submittedResult.request_id === 'kie-req-accept-1', `request id 是 ${submittedResult.request_id ?? '空'}`);
  assert(submittedResult.status === 'submitted', `有 request id 时状态是 ${submittedResult.status}`);

  const synced = captureFetch({ code: 200, data: { output: '同步文本' } });
  const syncResult = await new KieProviderClient({ apiKey: 'accept-kie-key', fetch: synced.fetch }).submit({
    model_id: 'z-image',
    endpoint: '/jobs/createTask',
    options: { prompt: '一只猫' },
  });
  assert(syncResult.status === 'succeeded', `没有 request id 时状态是 ${syncResult.status}`);
  assert(syncResult.request_id === undefined, '同步结果不应该带 request id');

  const failed = captureFetch({ msg: 'upstream down' }, 500);
  let requestError: unknown;
  try {
    await new KieProviderClient({ apiKey: 'accept-kie-key', fetch: failed.fetch }).submit({
      model_id: 'z-image',
      endpoint: '/jobs/createTask',
      options: { prompt: '一只猫' },
    });
  } catch (error) {
    requestError = error;
  }
  assert(requestError instanceof KieProviderRequestError, `HTTP 500 实际是 ${formatError(requestError)}`);
  assert(requestError.status === 500, `HTTP 错误状态是 ${requestError.status}`);

  return 'createTask 返回 taskId kie-req-accept-1，状态 submitted；没有 request id 时状态 succeeded；HTTP 500 抛出 KieProviderRequestError';
}

function checkNormalizer(): string {
  const model = requireCoreModel(productModels[0]?.id ?? '');
  const call = firstCall(model);
  assert(typeof call.normalizeResult === 'function', `${model.id} 没有 normalizeResult`);

  const succeeded = call.normalizeResult({
    code: 200,
    data: {
      state: 'success',
      resultJson: JSON.stringify({ resultUrls: ['https://cdn.example.com/cat.png'] }),
    },
  });
  assert(succeeded.status === 'succeeded', `成功响应状态是 ${succeeded.status}`);
  const mediaUrls = succeeded.outputs?.media_urls;
  assert(Array.isArray(mediaUrls) && mediaUrls.includes('https://cdn.example.com/cat.png'), '成功结果没有媒体 URL');

  const failed = call.normalizeResult({
    code: 501,
    msg: 'content rejected',
    data: { state: 'fail' },
  });
  assert(failed.status === 'failed', `失败响应状态是 ${failed.status}`);
  assert(failed.error?.message === 'content rejected', `失败消息是 ${failed.error?.message ?? '空'}`);
  assert(failed.outputs === undefined, '失败结果不应该带 outputs');

  const processing = call.normalizeResult({
    code: 200,
    data: { state: 'generating' },
  });
  assert(processing.status === 'processing', `处理中响应状态是 ${processing.status}`);
  assert(processing.error === undefined, '处理中结果不应该带 error');
  assert(processing.outputs === undefined, '处理中结果不应该带 outputs');

  return `${model.id} 把 success 归一成 succeeded，fail 归一成 failed，generating 归一成 processing`;
}

async function checkModelFile(): Promise<string> {
  const sources = await readModelSources();
  const indexSource = sources.get('index.ts') ?? '';
  const summaries: string[] = [];

  for (const product of productModels) {
    const owner = [...sources.entries()].find(([fileName, source]) => fileName !== 'index.ts' && source.includes(product.id));
    assert(owner, `${product.id} 不在 models 目录的模型文件里`);
    const [fileName, source] = owner;
    assert(source.includes('robin_calls'), `${fileName} 没有 robin_calls`);
    assert(
      indexSource.includes(`./${fileName.replace(/\.ts$/, '.js')}`),
      `${fileName} 没有被 models/index.ts 引入`,
    );

    const model = requireCoreModel(product.id);
    assert(model.id === product.id, `模型 id 是 ${model.id}`);
    assert(model.displayName.trim().length > 0, `${product.id} 没有 displayName`);
    const calls = model.robin_calls ?? [];
    assert(calls.length > 0, `${product.id} 没有 robin_calls`);
    for (const call of calls) {
      assert(String(call.provider).trim().length > 0, `${product.id} 的 Provider 为空`);
      assert(call.model_id.trim().length > 0, `${product.id} 的 provider model id 为空`);
      assert(RESULT_MODES.has(call.result_mode), `${product.id} 的 result_mode 是 ${call.result_mode}`);
      assert(typeof call.submit === 'function', `${product.id} 的 submit 不是函数`);
      assert(typeof call.normalizeResult === 'function', `${product.id} 的 normalizeResult 不是函数`);
    }
    summaries.push(`${fileName}: ${model.id} / ${calls.map((call) => `${call.provider}:${call.model_id}`).join(', ')}`);
  }

  return summaries.join('；');
}

async function checkCoreModelsRegistry(): Promise<string> {
  const sources = await readModelSources();
  const indexSource = sources.get('index.ts') ?? '';
  assert(indexSource.includes('export const CORE_MODELS'), 'models/index.ts 没有导出 CORE_MODELS');

  const registeredIds = CORE_MODELS.map((model) => model.id);
  const expectedIds = productModels.map((model) => model.id);
  assert(
    registeredIds.join(',') === expectedIds.join(','),
    `CORE_MODELS 是 [${registeredIds.join(', ')}]，初始注册表是 [${expectedIds.join(', ')}]`,
  );

  const detached: CoreModelEntity = {
    id: 'detached-model-accept',
    displayName: 'Detached',
    robin_calls: [],
  };
  assert(!CORE_MODELS.some((model) => model.id === detached.id), '未加入数组的模型出现在 CORE_MODELS');
  let missing: unknown;
  try {
    requireCoreModel(detached.id);
  } catch (error) {
    missing = error;
  }
  assertNamedError(missing, 'CoreModelNotRegisteredError', 'MODEL_NOT_REGISTERED');

  return `CORE_MODELS = [${registeredIds.join(', ')}]，${detached.id} 不在数组里，requireCoreModel() 找不到它`;
}

function checkResolveModelId(): string {
  const summaries: string[] = [];
  for (const model of productModels) {
    assert(model.aliases.length > 0, `${model.id} 没有 alias，无法验收 alias 解析`);
    assert(resolveCoreModelId(model.id) === model.id, `id ${model.id} 解析成 ${resolveCoreModelId(model.id)}`);
    assert(resolveCoreModelId(`  ${model.id}  `) === model.id, `带空白的 id 解析成 ${resolveCoreModelId(`  ${model.id}  `)}`);
    for (const alias of model.aliases) {
      const resolved = resolveCoreModelId(alias);
      assert(resolved === model.id, `alias ${alias} 解析成 ${resolved}`);
      assert(requireCoreModel(alias).id === model.id, `requireCoreModel(${alias}) 不是 ${model.id}`);
    }
    summaries.push(`${model.id} <= ${model.aliases.join(', ')}`);
  }
  const unknown = 'missing-model-accept';
  assert(resolveCoreModelId(unknown) === unknown, '未知模型 id 没有原样返回');
  return `${summaries.join('；')}；未知 id ${unknown} 原样返回`;
}

function checkUnregisteredModel(): string {
  const missingId = 'missing-model-accept';
  let first: unknown;
  let second: unknown;
  try {
    requireCoreModel(missingId);
  } catch (error) {
    first = error;
  }
  try {
    requireCoreModel(missingId);
  } catch (error) {
    second = error;
  }
  assertNamedError(first, 'CoreModelNotRegisteredError', 'MODEL_NOT_REGISTERED');
  assertNamedError(second, 'CoreModelNotRegisteredError', 'MODEL_NOT_REGISTERED');
  assert(first instanceof CoreModelNotRegisteredError && second instanceof CoreModelNotRegisteredError, '错误类型不稳定');
  assert(first.message === second.message, `两次错误消息不同：${first.message} / ${second.message}`);
  assert(first.message === `Model is not registered: ${missingId}`, `错误消息是 ${first.message}`);
  assert(first.modelId === missingId && second.modelId === missingId, '错误没有带上模型 id');
  return first.message;
}

function checkOptionValidation(): string {
  const model = requireCoreModel(productModels[0]?.id ?? '');
  const call = firstCall(model);
  const provider = String(call.provider);

  const defaults = validateCoreModelOptions(model.id, { prompt: 'cat' });
  assert(defaults.prompt === 'cat', '默认校验没有保留 prompt');
  assert(!('provider' in defaults), '默认校验混入了 provider');

  const pinned = validateCoreModelOptions(model.aliases?.[0] ?? model.id, { prompt: 'cat', provider: provider.toUpperCase() });
  assert(pinned.prompt === 'cat', '钉死 Provider 后没有保留 prompt');
  assert(pinned.provider === provider, `钉死 Provider 后 provider 是 ${String(pinned.provider)}`);

  let missingPrompt: unknown;
  try {
    validateCoreModelOptions(model.id, {});
  } catch (error) {
    missingPrompt = error;
  }
  assertValidationFailure(missingPrompt, 'prompt', 'required');

  let badSeed: unknown;
  try {
    validateCoreModelOptions(model.id, { prompt: 'cat', seed: '1' });
  } catch (error) {
    badSeed = error;
  }
  assertValidationFailure(badSeed, 'seed', 'invalid_type');

  let unavailable: unknown;
  try {
    validateCoreModelOptions(model.id, { prompt: 'cat', provider: 'missing-provider' });
  } catch (error) {
    unavailable = error;
  }
  assert(unavailable instanceof CoreProviderNotAvailableError, `钉死未知 Provider 实际是 ${formatError(unavailable)}`);
  assert(unavailable.code === 'PROVIDER_NOT_AVAILABLE', `未知 Provider code 是 ${unavailable.code}`);

  registerCoreModel({
    id: 'accept-schema-split',
    displayName: 'Accept Schema Split',
    robin_calls: [
      {
        provider: 'schema-a',
        model_id: 'schema-a-model',
        result_mode: 'webhook',
        options_schema: {
          type: 'object',
          required: ['prompt'],
          additionalProperties: false,
          properties: { prompt: { type: 'string', minLength: 1 } },
        },
        async submit() {
          return { provider: 'schema-a', model_id: 'schema-a-model', status: 'submitted' };
        },
        normalizeResult(): CoreProviderResult {
          return { status: 'processing' };
        },
      },
      {
        provider: 'schema-b',
        model_id: 'schema-b-model',
        result_mode: 'webhook',
        options_schema: {
          type: 'object',
          required: ['image_url'],
          additionalProperties: false,
          properties: { image_url: { type: 'string', minLength: 1 } },
        },
        async submit() {
          return { provider: 'schema-b', model_id: 'schema-b-model', status: 'submitted' };
        },
        normalizeResult(): CoreProviderResult {
          return { status: 'processing' };
        },
      },
    ],
  });

  const splitDefault = validateCoreModelOptions('accept-schema-split', { prompt: 'ok' });
  assert(splitDefault.prompt === 'ok' && !('provider' in splitDefault), '拆分模型的默认 schema 没有只接受 prompt');

  let splitMissingPrompt: unknown;
  try {
    validateCoreModelOptions('accept-schema-split', { image_url: 'https://cdn.example.com/a.png' });
  } catch (error) {
    splitMissingPrompt = error;
  }
  assertValidationFailure(splitMissingPrompt, 'prompt', 'required');

  const splitPinned = validateCoreModelOptions('accept-schema-split', {
    provider: 'schema-b',
    image_url: 'https://cdn.example.com/a.png',
  });
  assert(splitPinned.provider === 'schema-b', '钉死 schema-b 没有保留 provider');
  assert(splitPinned.image_url === 'https://cdn.example.com/a.png', '钉死 schema-b 没有保留 image_url');

  let splitWrongField: unknown;
  try {
    validateCoreModelOptions('accept-schema-split', { provider: 'schema-b', prompt: 'ok' });
  } catch (error) {
    splitWrongField = error;
  }
  assertValidationFailure(splitWrongField, 'image_url', 'required');

  return `${model.id} 默认要 prompt，钉死 ${provider} 会保留 provider；schema-a 要 prompt，钉死 schema-b 要 image_url`;
}

async function checkSubmitDefaultProvider(): Promise<string> {
  const model = requireCoreModel(productModels[0]?.id ?? '');
  const call = firstCall(model);
  assert(String(call.provider) === 'kie', `默认第一家是 ${String(call.provider)}，当前验收只注入了 kie`);

  return withKieFetch({ code: 200, data: { taskId: 'kie-submit-accept-1' } }, async (calls) => {
    const submitted = await submitCoreTask({
      ai_task_id: 'accept-submit-1',
      model_id: model.aliases?.[0] ?? model.id,
      options: { prompt: '一只猫' },
      webhook_url: WEBHOOK_URL,
    });
    assert(calls.length === 1, `默认提交调用了 ${calls.length} 次`);
    const request = calls[0];
    assert(request, '没有捕获到默认提交');
    assert(request.url === `${kieBaseUrl()}/jobs/createTask`, `默认提交地址是 ${request.url}`);
    assert(isRecord(request.body) && request.body.model === call.model_id, `默认提交 model 是 ${isRecord(request.body) ? String(request.body.model) : '空'}`);
    assert(submitted.provider === call.provider, `提交 provider 是 ${submitted.provider}`);
    assert(submitted.model_id === call.model_id, `提交 model 是 ${submitted.model_id}`);
    assert(submitted.provider_request_id === 'kie-submit-accept-1', `provider request id 是 ${submitted.provider_request_id ?? '空'}`);
    assert(submitted.status === 'submitted', `提交状态是 ${submitted.status}`);
    assert(submitted.result_mode === call.result_mode, `result_mode 是 ${submitted.result_mode ?? '空'}`);
    return `alias ${model.aliases?.[0] ?? model.id} 提交到 ${submitted.provider}:${submitted.model_id}，request id ${submitted.provider_request_id}`;
  });
}

async function checkRobinFallback(): Promise<string> {
  const attempts: string[] = [];
  registerCoreModel({
    id: 'accept-robin-fallback',
    displayName: 'Accept Robin',
    robin_calls: [
      {
        provider: 'robin-a',
        model_id: 'robin-a-model',
        result_mode: 'webhook',
        options_schema: {
          type: 'object',
          required: ['prompt'],
          additionalProperties: true,
          properties: { prompt: { type: 'string', minLength: 1 } },
        },
        async submit(input) {
          attempts.push(`${input.ai_task_id}:robin-a`);
          throw new Error('robin-a down');
        },
        normalizeResult(): CoreProviderResult {
          return { status: 'failed' };
        },
      },
      {
        provider: 'robin-b',
        model_id: 'robin-b-model',
        result_mode: 'webhook',
        options_schema: {
          type: 'object',
          required: ['prompt'],
          additionalProperties: true,
          properties: { prompt: { type: 'string', minLength: 1 } },
        },
        async submit(input) {
          attempts.push(`${input.ai_task_id}:robin-b`);
          return {
            provider: 'robin-b',
            model_id: 'robin-b-model',
            provider_request_id: 'robin-b-request',
            status: 'submitted',
          };
        },
        normalizeResult(): CoreProviderResult {
          return { status: 'processing' };
        },
      },
    ],
  });

  let coarseSkipError: unknown;
  try {
    await submitCoreTask({
      ai_task_id: 'accept-robin-coarse',
      model_id: 'accept-robin-fallback',
      options: { prompt: 'hello' },
      webhook_url: WEBHOOK_URL,
      skip_providers: ['robin-a'],
    });
  } catch (error) {
    coarseSkipError = error;
  }
  assert(coarseSkipError instanceof CoreProviderSubmitError, `只跳过 Provider 名时实际是 ${formatError(coarseSkipError)}`);
  assert(coarseSkipError.provider === 'robin-a' && coarseSkipError.providerModelId === 'robin-a-model', '跳过粒度不是 provider:model_id');

  const skipped = await submitCoreTask({
    ai_task_id: 'accept-robin-skip-key',
    model_id: 'accept-robin-fallback',
    options: { prompt: 'hello' },
    webhook_url: WEBHOOK_URL,
    skip_providers: ['robin-a:robin-a-model'],
  });
  assert(skipped.provider === 'robin-b', `跳过第一家后提交了 ${skipped.provider}`);
  assert(skipped.provider_request_id === 'robin-b-request', '跳过第一家后没有拿到第二家 request id');

  const repository = createRepository();
  const jobs: Array<{ name: string; data: { ai_task_id?: string; skip_providers?: readonly string[] }; jobId?: string }> = [];
  const processor = new ProviderWorkerProcessor(repository, undefined, {
    async add(name, data, options) {
      jobs.push({ name, data, ...(options?.jobId ? { jobId: options.jobId } : {}) });
      return { id: options?.jobId ?? name };
    },
  });
  const now = new Date();
  await repository.createOrGet({
    ai_task_id: 'accept-robin-open',
    status: 'queued',
    model_id: 'accept-robin-fallback',
    core_model_id: 'accept-robin-fallback',
    options: { prompt: 'hello' },
    webhook_url: WEBHOOK_URL,
    created_at: now,
    updated_at: now,
  });
  await repository.createOrGet({
    ai_task_id: 'accept-robin-pinned',
    status: 'queued',
    model_id: 'accept-robin-fallback',
    core_model_id: 'accept-robin-fallback',
    options: { prompt: 'hello', provider: 'robin-a' },
    webhook_url: WEBHOOK_URL,
    created_at: now,
    updated_at: now,
  });

  const failedAttempt = await processor.process({ ai_task_id: 'accept-robin-open' });
  assert(failedAttempt.status === 'queued', `第一家失败后状态是 ${failedAttempt.status}`);
  assert(jobs.length === 1, `第一家失败后入队 ${jobs.length} 个任务`);
  const fallbackJob = jobs[0];
  assert(fallbackJob?.name === 'submit', `回退任务名是 ${fallbackJob?.name ?? '空'}`);
  assert(
    JSON.stringify(fallbackJob?.data.skip_providers ?? []) === JSON.stringify(['robin-a:robin-a-model']),
    `skip_providers 是 ${JSON.stringify(fallbackJob?.data.skip_providers ?? [])}`,
  );
  assert(
    fallbackJob?.jobId === 'provider-accept-robin-open-fallback-robin-b-robin-b-model',
    `回退 jobId 是 ${fallbackJob?.jobId ?? '空'}`,
  );

  const fallbackTask = await processor.process({
    ai_task_id: 'accept-robin-open',
    skip_providers: [...(fallbackJob?.data.skip_providers ?? [])],
  });
  assert(fallbackTask.status === 'waiting_provider', `第二家提交后状态是 ${fallbackTask.status}`);
  assert(fallbackTask.provider === 'robin-b', `第二家 provider 是 ${fallbackTask.provider ?? '空'}`);
  assert(fallbackTask.provider_request_id === 'robin-b-request', `第二家 request id 是 ${fallbackTask.provider_request_id ?? '空'}`);

  const pinnedTask = await processor.process({ ai_task_id: 'accept-robin-pinned' });
  assert(pinnedTask.status === 'failed', `钉死 Provider 失败后状态是 ${pinnedTask.status}`);
  assert(jobs.length === 1, '钉死 Provider 后又入队了回退任务');
  assert(
    attempts.filter((item) => item.startsWith('accept-robin-pinned:')).join(',') === 'accept-robin-pinned:robin-a',
    `钉死任务的调用是 ${attempts.filter((item) => item.startsWith('accept-robin-pinned:')).join(',')}`,
  );

  const probe = '运行时探针：跳过 robin-a:robin-a-model 后提交 robin-b；worker 失败后入队第二家并写成 waiting_provider；钉死 robin-a 时失败且不入队';
  const gaps = productModels.filter((model) => model.providers.length < 2);
  if (gaps.length > 0) {
    const described = gaps.map((model) => `${model.id} 只有 ${model.providers.length} 条 robin_calls（${model.providers.join(', ') || '无'}）`).join('；');
    throw new Error(`${described}，第一家失败后没有下一家。${probe}`);
  }

  const summaries: string[] = [];
  for (const product of productModels) {
    const model = requireCoreModel(product.id);
    const calls = model.robin_calls ?? [];
    const current = calls[0];
    const expected = calls[1];
    assert(current && expected, `${product.id} 的 robin_calls 不足两条`);
    const remaining = getRemainingRobinProviders(product.id, String(current.provider), current.model_id, {});
    assert(
      remaining[0]?.provider === String(expected.provider) && remaining[0]?.model_id === expected.model_id,
      `${product.id} 的下一跳是 ${JSON.stringify(remaining[0] ?? null)}`,
    );
    const pinned = getRemainingRobinProviders(product.id, String(current.provider), current.model_id, { provider: String(current.provider) });
    assert(pinned.length === 0, `${product.id} 钉死 ${String(current.provider)} 后还有 ${pinned.length} 家`);
    summaries.push(`${product.id}: ${current.provider}:${current.model_id} -> ${expected.provider}:${expected.model_id}`);
  }
  return `${summaries.join('；')}。${probe}`;
}

async function checkProviderWorker(): Promise<string> {
  const model = requireCoreModel(productModels[0]?.id ?? '');
  const call = firstCall(model);
  assert(String(call.provider) === 'kie', `worker 验收目前只注入了 kie，实际第一家是 ${String(call.provider)}`);
  const repository = createRepository();
  const now = new Date();
  await repository.createOrGet({
    ai_task_id: 'accept-worker-1',
    status: 'queued',
    model_id: model.aliases?.[0] ?? model.id,
    core_model_id: model.id,
    options: { prompt: '一只猫' },
    webhook_url: WEBHOOK_URL,
    created_at: now,
    updated_at: now,
  });

  return withKieFetch({ code: 200, data: { taskId: 'accept-kie-request-1' } }, async (calls) => {
    const processor = new ProviderWorkerProcessor(repository);
    const updated = await processor.process({ ai_task_id: 'accept-worker-1' });
    const stored = await repository.getById('accept-worker-1');
    assert(calls.length === 1, `worker 提交调用了 ${calls.length} 次`);
    const request = calls[0];
    assert(isRecord(request?.body) && request.body.model === call.model_id, 'worker 没有把任务交给默认 Provider 模型');
    assert(updated.status === 'waiting_provider', `返回状态是 ${updated.status}`);
    assert(stored?.status === 'waiting_provider', `库存状态是 ${stored?.status ?? '空'}`);
    assert(stored?.provider === 'kie', `库存 provider 是 ${stored?.provider ?? '空'}`);
    assert(stored?.provider_model_id === call.model_id, `库存 provider model 是 ${stored?.provider_model_id ?? '空'}`);
    assert(stored?.provider_request_id === 'accept-kie-request-1', `库存 request id 是 ${stored?.provider_request_id ?? '空'}`);
    assert(stored?.result_mode === 'webhook', `库存 result_mode 是 ${stored?.result_mode ?? '空'}`);
    assert(stored?.attempt === 1, `库存 attempt 是 ${stored?.attempt ?? '空'}`);
    return `model_id ${model.aliases?.[0] ?? model.id} 从 queued 写成 waiting_provider，provider_request_id=accept-kie-request-1`;
  });
}

async function loadCatalog(): Promise<Catalog> {
  catalogPromise ??= buildCatalog();
  return catalogPromise;
}

async function buildCatalog(): Promise<Catalog> {
  const frontendModule = await import('../novelcomic-frontend/src/constants/cloudModelData.ts');
  const frontend = frontendModule.LOCAL_CLOUD_MODEL_DATA as FrontendModel[];
  const lookups = [
    ...productModels.flatMap((model) => [
      { model_id: model.id, config_name: '' },
      ...model.aliases.map((alias) => ({ model_id: alias, config_name: '' })),
      { model_id: model.id, config_name: 'text_to_image_config' },
    ]),
    { model_id: 'default', config_name: 'text_to_image_config' },
    { model_id: 'default', config_name: 'imageModel' },
    { model_id: 'default', config_name: 'image_model' },
    { model_id: 'not-registered-model', config_name: '' },
    ...frontend.map((model) => ({ model_id: model.id, config_name: model.configName ?? '' })),
  ];
  const payload = await runPythonCatalog({ root: ROOT, lookups });
  return { ...payload, frontend };
}

function runPythonCatalog(input: unknown): Promise<Omit<Catalog, 'frontend'>> {
  const python = `
import importlib.util
import json
import sys
import traceback
from pathlib import Path

def load(name, file_path):
    spec = importlib.util.spec_from_file_location(name, file_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load %s" % file_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def map_one(mapper, model_id, config_name):
    try:
        mapped = mapper.OpenCreatorAIModelMapper.to_opencreator_model_id(model_id, config_name)
        return {"model_id": model_id, "config_name": config_name, "mapped": mapped, "error": None}
    except Exception as exc:
        return {"model_id": model_id, "config_name": config_name, "mapped": None, "error": str(exc)}

def main():
    payload = json.loads(sys.stdin.read())
    root = Path(payload["root"])
    mapper = load("nc_model_mapper", root / "novelcomic-consumer/app/services/opencreator_ai/model_mapper.py")
    builder = load("nc_options_builder", root / "novelcomic-consumer/app/services/opencreator_ai/options_builder.py")
    sys.path.insert(0, str(root / "novelcomic-publisher"))
    from app.services.model_config import BUILT_IN_PUBLIC_MODEL_CONFIGS

    class Request:
        def __init__(self, model_id, arguments, model_options):
            self.model_id = model_id
            self.arguments = arguments
            self.model_options = model_options

    publisher = []
    for item in BUILT_IN_PUBLIC_MODEL_CONFIGS:
        publisher.append({
            "config_name": item.get("config_name") or "",
            "model_id": item.get("model_id") or "",
            "display_name": item.get("display_name") or "",
            "brand": item.get("brand") or "",
        })

    mappings = []
    for item in publisher:
        mappings.append(map_one(mapper, item["model_id"], item["config_name"]))
    for item in payload["lookups"]:
        mappings.append(map_one(mapper, item["model_id"], item.get("config_name") or ""))

    source_model_id = "kie-image"
    config_name = "text_to_image_config"
    mapped_model_id = mapper.OpenCreatorAIModelMapper.to_opencreator_model_id(source_model_id, config_name)
    options = builder.OpenCreatorAIOptionsBuilder.build(Request(
        mapped_model_id,
        {"text": "一只在雨里的猫", "aspectRatio": "16:9", "negativePrompt": "模糊"},
        {"seed": 11, "provider": "kie"},
    ))
    sys.stdout.write(json.dumps({
        "mappings": mappings,
        "publisher": publisher,
        "options": {
            "model_id": source_model_id,
            "config_name": config_name,
            "mapped_model_id": mapped_model_id,
            "options": options,
        },
    }, ensure_ascii=False))

try:
    main()
except Exception:
    traceback.print_exc()
    sys.exit(1)
`;

  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), ['-c', python], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Consumer/Publisher 验收超时'));
    }, 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout || `python exited ${code ?? 'null'}`).trim()));
        return;
      }
      const start = stdout.indexOf('{');
      const end = stdout.lastIndexOf('}');
      if (start < 0 || end < start) {
        reject(new Error(stderr || stdout || 'python 没有输出 JSON'));
        return;
      }
      try {
        resolve(parseCatalog(JSON.parse(stdout.slice(start, end + 1)) as unknown));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function parseCatalog(value: unknown): Omit<Catalog, 'frontend'> {
  assert(isRecord(value), '验收输出不是对象');
  assert(Array.isArray(value.mappings), '验收输出没有 mappings');
  assert(Array.isArray(value.publisher), '验收输出没有 publisher');
  assert(isRecord(value.options), '验收输出没有 options');
  const options = value.options;
  assert(typeof options.model_id === 'string', 'options.model_id 不是字符串');
  assert(typeof options.config_name === 'string', 'options.config_name 不是字符串');
  assert(typeof options.mapped_model_id === 'string', 'options.mapped_model_id 不是字符串');
  assert(isRecord(options.options), '构造出的 options 不是对象');
  return {
    mappings: value.mappings.map(parseMappedModel),
    publisher: value.publisher.map(parsePublisherModel),
    options: {
      model_id: options.model_id,
      config_name: options.config_name,
      mapped_model_id: options.mapped_model_id,
      options: options.options as JsonObject,
    },
  };
}

function parseMappedModel(value: unknown): MappedModel {
  assert(isRecord(value), 'mapping 不是对象');
  assert(typeof value.model_id === 'string', 'mapping.model_id 不是字符串');
  assert(typeof value.config_name === 'string', 'mapping.config_name 不是字符串');
  assert(value.mapped === null || typeof value.mapped === 'string', 'mapping.mapped 类型不对');
  assert(value.error === null || typeof value.error === 'string', 'mapping.error 类型不对');
  return {
    model_id: value.model_id,
    config_name: value.config_name,
    mapped: value.mapped,
    error: value.error,
  };
}

function parsePublisherModel(value: unknown): PublisherModel {
  assert(isRecord(value), 'publisher 模型不是对象');
  assert(typeof value.config_name === 'string' && typeof value.model_id === 'string', 'publisher 模型缺少 id');
  assert(typeof value.display_name === 'string' && typeof value.brand === 'string', 'publisher 模型缺少展示字段');
  return {
    config_name: value.config_name,
    model_id: value.model_id,
    display_name: value.display_name,
    brand: value.brand,
  };
}

function indexMappings(rows: readonly MappedModel[]): Map<string, MappedModel> {
  const indexed = new Map<string, MappedModel>();
  for (const row of rows) {
    indexed.set(mappingKey(row.model_id, row.config_name), row);
  }
  return indexed;
}

function knownCoreIds(): Set<string> {
  return new Set(productModels.map((model) => model.id));
}

async function checkConsumerMapping(): Promise<string> {
  const catalog = await loadCatalog();
  const indexed = indexMappings(catalog.mappings);
  const known = knownCoreIds();
  const summaries: string[] = [];

  for (const model of productModels) {
    for (const sourceId of [model.id, ...model.aliases]) {
      const row = indexed.get(mappingKey(sourceId, ''));
      assert(row?.mapped, `${sourceId} 没有映射：${row?.error ?? '无结果'}`);
      assert(known.has(resolveCoreModelId(row.mapped)), `${sourceId} 映射到 ${row.mapped}，初始 AI registry 不认识`);
      assert(requireCoreModel(row.mapped).id === model.id, `${sourceId} 映射到 ${row.mapped}，registry 规范 id 不是 ${model.id}`);
      summaries.push(`${sourceId} -> ${row.mapped}`);
    }
  }

  for (const configName of ['text_to_image_config', 'imageModel', 'image_model']) {
    const row = indexed.get(mappingKey('default', configName));
    assert(row?.mapped, `${configName}/default 没有映射：${row?.error ?? '无结果'}`);
    assert(known.has(resolveCoreModelId(row.mapped)), `${configName}/default 映射到 ${row.mapped}，AI registry 不认识`);
    summaries.push(`${configName}/default -> ${row.mapped}`);
  }

  const missing = indexed.get(mappingKey('not-registered-model', ''));
  assert(missing?.mapped === null && missing.error, '未登记的业务模型没有被映射层拒绝');
  return `${summaries.join('；')}；not-registered-model 被拒绝`;
}

async function checkConsumerOptions(): Promise<string> {
  const catalog = await loadCatalog();
  const { model_id: sourceModelId, mapped_model_id: mappedModelId, options } = catalog.options;
  assert(sourceModelId === 'kie-image', `构造 options 的来源模型是 ${sourceModelId}`);
  assert(knownCoreIds().has(resolveCoreModelId(mappedModelId)), `${mappedModelId} 不在初始 AI registry`);
  assert(options.prompt === '一只在雨里的猫', `prompt 是 ${String(options.prompt)}`);
  assert(options.aspect_ratio === '16:9', `aspect_ratio 是 ${String(options.aspect_ratio)}`);
  assert(options.negative_prompt === '模糊', `negative_prompt 是 ${String(options.negative_prompt)}`);
  assert(options.seed === 11, `seed 是 ${String(options.seed)}`);
  assert(options.provider === 'kie', `provider 是 ${String(options.provider)}`);

  const validated = validateCoreModelOptions(mappedModelId, options);
  assert(validated.prompt === '一只在雨里的猫', '校验后丢掉了 prompt');
  assert(validated.provider === 'kie', '校验后丢掉了钉死的 provider');

  const broken: JsonObject = { ...validated };
  delete broken.prompt;
  let invalid: unknown;
  try {
    validateCoreModelOptions(mappedModelId, broken);
  } catch (error) {
    invalid = error;
  }
  assertValidationFailure(invalid, 'prompt', 'required');
  return `${sourceModelId} -> ${mappedModelId} 的 options 通过校验，去掉 prompt 后被拒绝`;
}

function alignmentProblems(input: {
  publisher: readonly PublisherModel[];
  frontend: readonly FrontendModel[];
  mappings: Map<string, MappedModel>;
  models: readonly ProductModel[];
}): string[] {
  const problems: string[] = [];
  const known = new Set(input.models.map((model) => model.id));
  const publisherKeys = new Set(input.publisher.map((model) => `${model.config_name}::${model.model_id}`));
  const frontendKeys = new Set(input.frontend.map((model) => `${model.configName ?? ''}::${model.id}`));

  for (const key of publisherKeys) {
    if (!frontendKeys.has(key)) {
      problems.push(`Frontend 目录缺少 ${key}`);
    }
  }
  for (const key of frontendKeys) {
    if (!publisherKeys.has(key)) {
      problems.push(`Publisher 目录缺少 ${key}`);
    }
  }

  for (const model of input.publisher) {
    const mapped = input.mappings.get(mappingKey(model.model_id, model.config_name));
    if (!mapped?.mapped) {
      problems.push(`Publisher ${model.model_id} 没有 Consumer 映射`);
      continue;
    }
    if (!known.has(resolveCoreModelId(mapped.mapped))) {
      problems.push(`Publisher ${model.model_id} 映射到 ${mapped.mapped}，AI registry 不认识`);
    }
    const core = input.models.find((entry) => entry.id === resolveCoreModelId(mapped.mapped ?? ''));
    if (core && model.display_name !== core.displayName) {
      problems.push(`Publisher 展示名 ${model.display_name} 和 registry ${core.displayName} 不一致`);
    }
    if (core && model.brand !== core.providers[0]) {
      problems.push(`Publisher brand ${model.brand} 和默认 Provider ${core.providers[0] ?? '空'} 不一致`);
    }
  }

  for (const model of input.frontend) {
    if (!model.configName) {
      problems.push(`Frontend ${model.id} 没有 configName`);
      continue;
    }
    const mapped = input.mappings.get(mappingKey(model.id, model.configName));
    if (!mapped?.mapped) {
      problems.push(`Frontend ${model.id} 没有 Consumer 映射`);
      continue;
    }
    if (!known.has(resolveCoreModelId(mapped.mapped))) {
      problems.push(`Frontend ${model.id} 映射到 ${mapped.mapped}，AI registry 不认识`);
    }
    const core = input.models.find((entry) => entry.id === resolveCoreModelId(mapped.mapped ?? ''));
    if (core && model.label !== core.displayName) {
      problems.push(`Frontend 展示名 ${model.label} 和 registry ${core.displayName} 不一致`);
    }
    if (core && model.brand !== core.providers[0]) {
      problems.push(`Frontend brand ${String(model.brand)} 和默认 Provider ${core.providers[0] ?? '空'} 不一致`);
    }
  }

  for (const model of input.models) {
    if (!input.publisher.some((entry) => entry.model_id === model.id)) {
      problems.push(`CORE_MODELS ${model.id} 不在 Publisher 目录`);
    }
    if (!input.frontend.some((entry) => entry.id === model.id)) {
      problems.push(`CORE_MODELS ${model.id} 不在 Frontend 目录`);
    }
    for (const alias of model.aliases) {
      const mapped = input.mappings.get(mappingKey(alias, ''));
      if (mapped?.mapped !== model.id) {
        problems.push(`alias ${alias} 映射到 ${mapped?.mapped ?? '无'}，不是 ${model.id}`);
      }
    }
  }

  return problems;
}

async function checkCatalogAlignment(): Promise<string> {
  const catalog = await loadCatalog();
  const mappings = indexMappings(catalog.mappings);
  const problems = alignmentProblems({
    publisher: catalog.publisher,
    frontend: catalog.frontend,
    mappings,
    models: productModels,
  });
  assert(problems.length === 0, problems.join('；'));

  const withoutFrontend = alignmentProblems({
    publisher: catalog.publisher,
    frontend: [],
    mappings,
    models: productModels,
  });
  const withoutPublisher = alignmentProblems({
    publisher: [],
    frontend: catalog.frontend,
    mappings,
    models: productModels,
  });
  const withoutMapping = new Map(mappings);
  for (const model of catalog.publisher) {
    withoutMapping.delete(mappingKey(model.model_id, model.config_name));
  }
  const missingConsumer = alignmentProblems({
    publisher: catalog.publisher,
    frontend: catalog.frontend,
    mappings: withoutMapping,
    models: productModels,
  });
  assert(withoutFrontend.some((problem) => problem.includes('Frontend')), `去掉 Frontend 后的失败是 ${withoutFrontend.join('；') || '没有失败'}`);
  assert(withoutPublisher.some((problem) => problem.includes('Publisher')), `去掉 Publisher 后的失败是 ${withoutPublisher.join('；') || '没有失败'}`);
  assert(missingConsumer.some((problem) => problem.includes('Consumer')), `去掉 Consumer 映射后的失败是 ${missingConsumer.join('；') || '没有失败'}`);

  const listed = productModels.map((model) => model.id).join(', ');
  return `Publisher、Frontend、Consumer、AI registry 都对齐到 ${listed}；去掉任意一边都会指出缺的那一边`;
}

async function main(): Promise<number> {
  const results: StepResult[] = [];
  for (const [index, step] of steps.entries()) {
    try {
      const detail = await step.run();
      results.push({
        step: index + 1,
        name: step.name,
        ok: detail.trim().length > 0,
        detail: detail.trim().length > 0 ? detail : '这一步没有产生验收结果',
      });
    } catch (error) {
      results.push({
        step: index + 1,
        name: step.name,
        ok: false,
        detail: formatError(error),
      });
    }
  }

  const passed = results.filter((result) => result.ok).length;
  for (const result of results) {
    const mark = result.ok ? '通过' : '失败';
    console.log(`${mark} ${String(result.step).padStart(2, '0')} ${result.name} — ${result.detail.replaceAll('\n', ' ')}`);
  }
  console.log(passed === results.length
    ? `闭环 ${passed}/${results.length}。整条通路已通过。`
    : `闭环 ${passed}/${results.length}。整条通路未通过。`);
  return passed === results.length ? 0 : 1;
}

main().then((code) => {
  process.exit(code);
}).catch((error: unknown) => {
  console.error(formatError(error));
  process.exit(1);
});
