import { createHash } from 'node:crypto';
import { CORE_MODELS as REGISTERED_CORE_MODELS } from './models/index.js';
import {
  validateOptionsAgainstConstraintSet,
  type ModelOptionFieldConstraint,
  type ModelOptionValueType,
  type ModelOptionsConstraintSet,
} from './model-constraints.js';
import type { CoreModelEntity, CoreProviderCall, CoreRunContext, CoreSubmitResult, JsonObject } from './types.js';

export type { CoreModelEntity } from './types.js';

const REQUESTED_PROVIDER_OPTION_KEY = 'provider';

export class CoreModelNotRegisteredError extends Error {
  readonly code = 'MODEL_NOT_REGISTERED';

  constructor(readonly modelId: string) {
    super(`Model is not registered: ${modelId}`);
    this.name = 'CoreModelNotRegisteredError';
  }
}

export const CORE_MODELS: CoreModelEntity[] = [...REGISTERED_CORE_MODELS];

export function registerCoreModel(model: CoreModelEntity): CoreModelEntity {
  const existing = CORE_MODELS.find((entry) => entry.id === model.id);
  if (existing) {
    return existing;
  }

  CORE_MODELS.push(model);
  return model;
}

export function listCoreModels(): CoreModelEntity[] {
  return [...CORE_MODELS];
}

export function resolveCoreModelId(modelId: string): string {
  const normalizedModelId = modelId.trim();

  for (const entry of CORE_MODELS) {
    if (entry.id === normalizedModelId || entry.aliases?.includes(normalizedModelId)) {
      return entry.id;
    }
  }

  return normalizedModelId;
}

export function requireCoreModel(modelId: string): CoreModelEntity {
  const coreModelId = resolveCoreModelId(modelId);
  const entry = CORE_MODELS.find((candidate) => candidate.id === coreModelId);

  if (!entry) {
    throw new CoreModelNotRegisteredError(modelId);
  }

  return entry;
}

export function extractRequestedProviderFromOptions(options: JsonObject): string | undefined {
  const rawProvider = options[REQUESTED_PROVIDER_OPTION_KEY];
  if (typeof rawProvider !== 'string') {
    return undefined;
  }

  const provider = rawProvider.trim().toLowerCase();
  return provider.length > 0 ? provider : undefined;
}

export function stripProviderFromOptions<TOptions extends JsonObject>(options: TOptions): JsonObject {
  const { [REQUESTED_PROVIDER_OPTION_KEY]: ignored, ...cleanedOptions } = options;
  void ignored;
  return cleanedOptions;
}

export function validateCoreModelOptions<TOptions extends JsonObject>(
  modelId: string,
  options: TOptions,
): JsonObject {
  const entry = requireCoreModel(modelId);
  const requestedProvider = extractRequestedProviderFromOptions(options);
  const call = selectCoreCall(entry, requestedProvider);
  const optionsForProvider = requestedProvider ? stripProviderFromOptions(options) : options;
  const schemaConstraints = optionConstraintsFromJsonSchema(call.options_schema);

  if (schemaConstraints) {
    validateOptionsAgainstConstraintSet(entry.id, optionsForProvider, schemaConstraints);
  }

  if (!requestedProvider) {
    return optionsForProvider;
  }

  return { ...optionsForProvider, [REQUESTED_PROVIDER_OPTION_KEY]: requestedProvider };
}

export function getRemainingRobinProviders(
  modelId: string,
  currentProvider: string,
  currentProviderModelId?: string,
  taskOptions: JsonObject = {},
): Array<{ provider: string; model_id: string }> {
  if (extractRequestedProviderFromOptions(taskOptions)) {
    return [];
  }

  const entry = CORE_MODELS.find((model) => model.id === resolveCoreModelId(modelId));
  if (!entry?.robin_calls) {
    return [];
  }

  const currentIndex = entry.robin_calls.findIndex((call) => (
    call.provider === currentProvider
    && (!currentProviderModelId || call.model_id === currentProviderModelId)
  ));

  if (currentIndex < 0) {
    return [];
  }

  return entry.robin_calls.slice(currentIndex + 1).map((call) => ({
    provider: call.provider,
    model_id: call.model_id,
  }));
}

export interface SubmitCoreTaskInput<TOptions extends JsonObject = JsonObject> extends CoreRunContext<TOptions> {}

export async function submitCoreTask<TOptions extends JsonObject = JsonObject>(
  input: SubmitCoreTaskInput<TOptions>,
): Promise<CoreSubmitResult> {
  const entry = requireCoreModel(input.model_id);
  const requestedProvider = extractRequestedProviderFromOptions(input.options);
  const calls = orderedCalls(entry, requestedProvider, input.skip_providers);
  const call = calls[0];

  if (!call) {
    throw new CoreProviderCallNotFoundError(entry.id, requestedProvider);
  }

  const validatedOptions = validateCoreModelOptions(entry.id, input.options);
  const providerOptions = stripProviderFromOptions(validatedOptions);

  try {
    const submit = await call.submit({
      ai_task_id: input.ai_task_id,
      model_id: entry.id,
      options: providerOptions,
      ...(input.webhook_url ? { webhook_url: input.webhook_url } : {}),
    });

    const normalizedSubmit: CoreSubmitResult = {
      ...submit,
      result_mode: submit.result_mode ?? call.result_mode,
    };
    const providerRequestId = submit.provider_request_id ?? submit.request_id;
    if (providerRequestId) {
      normalizedSubmit.provider_request_id = providerRequestId;
    }
    return normalizedSubmit;
  } catch (error) {
    throw new CoreProviderSubmitError(entry.id, call.provider, call.model_id, error);
  }
}

export class CoreProviderNotAvailableError extends Error {
  readonly code = 'PROVIDER_NOT_AVAILABLE';

  constructor(readonly modelId: string, readonly provider: string) {
    super(`Provider is not available for model ${modelId}: ${provider}`);
    this.name = 'CoreProviderNotAvailableError';
  }
}

export class CoreProviderCallNotFoundError extends Error {
  readonly code = 'PROVIDER_CALL_NOT_FOUND';

  constructor(readonly modelId: string, readonly provider?: string) {
    super(provider ? `Provider call is not available for model ${modelId}: ${provider}` : `No provider call is available for model ${modelId}`);
    this.name = 'CoreProviderCallNotFoundError';
  }
}

export class CoreProviderSubmitError extends Error {
  readonly code = 'PROVIDER_SUBMIT_FAILED';

  constructor(
    readonly modelId: string,
    readonly provider: string,
    readonly providerModelId: string,
    readonly cause: unknown,
  ) {
    super(`Provider submit failed for model ${modelId}: ${provider}:${providerModelId}`);
    this.name = 'CoreProviderSubmitError';
  }
}

function selectCoreCall(entry: CoreModelEntity, requestedProvider?: string): CoreProviderCall {
  const call = orderedCalls(entry, requestedProvider)[0];
  if (!call) {
    throw requestedProvider
      ? new CoreProviderNotAvailableError(entry.id, requestedProvider)
      : new CoreProviderCallNotFoundError(entry.id);
  }
  return call;
}

function orderedCalls(
  entry: CoreModelEntity,
  requestedProvider?: string,
  skipProviders: readonly string[] = [],
): CoreProviderCall[] {
  const calls = entry.robin_calls ?? [];
  const skipped = new Set(skipProviders);
  const filteredCalls = requestedProvider
    ? calls.filter((call) => call.provider === requestedProvider)
    : calls;

  return filteredCalls.filter((call) => !skipped.has(providerCallKey(call)));
}

function providerCallKey(call: CoreProviderCall): string {
  return `${call.provider}:${call.model_id}`;
}

function optionConstraintsFromJsonSchema(schema: JsonObject | undefined): ModelOptionsConstraintSet | undefined {
  if (!schema || schema.type !== 'object' || !isRecord(schema.properties)) {
    return undefined;
  }

  const requiredFields = new Set(
    Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === 'string') : [],
  );
  const fields: Record<string, ModelOptionFieldConstraint> = {};

  for (const [field, propertySchema] of Object.entries(schema.properties)) {
    if (!isRecord(propertySchema)) {
      continue;
    }

    const type = jsonSchemaTypeToOptionType(propertySchema.type);
    if (!type) {
      continue;
    }

    const constraint: ModelOptionFieldConstraint = { type };
    if (requiredFields.has(field)) constraint.required = true;
    if (Array.isArray(propertySchema.enum)) constraint.enum = propertySchema.enum.filter(isEnumValue);
    if (typeof propertySchema.minimum === 'number') constraint.min = propertySchema.minimum;
    if (typeof propertySchema.maximum === 'number') constraint.max = propertySchema.maximum;
    if (typeof propertySchema.minLength === 'number') constraint.minLength = propertySchema.minLength;
    if (typeof propertySchema.maxLength === 'number') constraint.maxLength = propertySchema.maxLength;

    fields[field] = constraint;
  }

  return {
    fields,
    ...(schema.additionalProperties === false ? { strict: true } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonSchemaTypeToOptionType(value: unknown): ModelOptionValueType | undefined {
  if (value === 'integer') {
    return 'number';
  }
  if (
    value === 'string'
    || value === 'number'
    || value === 'boolean'
    || value === 'object'
    || value === 'array'
    || value === 'null'
  ) {
    return value;
  }
  return undefined;
}

function isEnumValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

export interface ParsedCoreProviderWebhook {
  ai_task_id?: string;
  provider_request_id?: string;
  provider_model_id?: string;
  provider_status?: string;
  event_id?: string;
  event_type?: string;
  attempt?: number;
}

export function parseCoreProviderWebhook(
  provider: string,
  payload: unknown,
  headers: Record<string, string | undefined>,
): ParsedCoreProviderWebhook {
  void provider;
  void headers;
  return compactWebhook({
    ai_task_id: readFirstString(payload, ['ai_task_id', 'aiTaskId', 'external_task_id', 'data.ai_task_id', 'data.aiTaskId', 'data.external_task_id']),
    provider_request_id: readFirstString(payload, [
      'provider_request_id',
      'request_id',
      'requestId',
      'task_id',
      'taskId',
      'data.provider_request_id',
      'data.request_id',
      'data.requestId',
      'data.task_id',
      'data.taskId',
    ]),
    provider_model_id: readFirstString(payload, ['provider_model_id', 'model_id', 'modelId', 'data.provider_model_id', 'data.model_id', 'data.modelId']),
    provider_status: readFirstString(payload, ['provider_status', 'status', 'state', 'data.provider_status', 'data.status', 'data.state', 'data.taskStatus']),
    event_id: readFirstString(payload, ['event_id', 'eventId', 'id', 'data.event_id', 'data.eventId', 'data.id']),
    event_type: readFirstString(payload, ['event_type', 'eventType', 'type', 'data.event_type', 'data.eventType', 'data.type']),
    attempt: readFirstNumber(payload, ['attempt', 'data.attempt']),
  });
}

export function verifyTencentWebhookSignature(
  payload: unknown,
  signKey: string | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): { valid: boolean; reason?: string } {
  if (!signKey) {
    return { valid: true, reason: 'signKey not configured' };
  }

  const body = isRecord(payload) ? payload : {};
  const sign = body.Sign;
  const timestamp = body.T;
  if (typeof sign !== 'string' || sign.length === 0 || timestamp === undefined || timestamp === null) {
    return { valid: false, reason: 'missing Sign/T' };
  }

  const expected = createHash('md5').update(`${signKey}${String(timestamp)}`, 'utf8').digest('hex');
  if (expected.toLowerCase() !== sign.toLowerCase()) {
    return { valid: false, reason: 'sign mismatch' };
  }
  if (Number(timestamp) < nowSec) {
    return { valid: false, reason: 'signature expired' };
  }
  return { valid: true };
}

function compactWebhook(input: Record<string, string | number | undefined>): ParsedCoreProviderWebhook {
  const output: ParsedCoreProviderWebhook = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      Object.assign(output, { [key]: value });
    }
  }
  return output;
}

function readFirstString(value: unknown, paths: readonly string[]): string | undefined {
  for (const path of paths) {
    const found = readPath(value, path.split('.'));
    if (typeof found === 'string' && found.trim()) {
      return found.trim();
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
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}
