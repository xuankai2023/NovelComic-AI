import modelConstraintsJson from '../data/model_constraints.json' with { type: 'json' };

export type ModelOptionValueType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

export type ModelOptionEnumValue = string | number | boolean | null;

export interface ModelOptionFieldConstraint {
  type: ModelOptionValueType;
  required?: boolean;
  enum?: readonly ModelOptionEnumValue[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  itemType?: ModelOptionValueType;
}

export interface ModelOptionsConstraintSet {
  fields: Record<string, ModelOptionFieldConstraint>;
  strict?: boolean;
}

export interface ProviderRetryConfig {
  maxRetries: number;
  baseDelayMs: number;
}

export interface ProviderEntry {
  label: { zh: string; en: string };
  retryConfig: ProviderRetryConfig;
}

export interface ModelConstraints {
  config_name?: string;
  model_id?: string;
  display_name?: string;
  provider?: string;
  providerModelId?: string;
  promptRequired?: boolean;
  promptMaxLength?: number;
  supportedInputModalities?: string[];
  supportedMediaTypes?: string[];
  params?: Record<string, unknown>;
}

export interface ModelConstraintsConfig {
  version: string;
  providers: Record<string, ProviderEntry>;
  models: Record<string, ModelConstraints>;
}

export interface ModelOptionsValidationIssue {
  path: string;
  code:
    | 'required'
    | 'unknown_field'
    | 'invalid_type'
    | 'invalid_enum'
    | 'number_too_small'
    | 'number_too_large'
    | 'string_too_short'
    | 'string_too_long';
  message: string;
}

export class CoreModelOptionsValidationError extends Error {
  readonly code = 'MODEL_OPTIONS_INVALID';

  constructor(
    readonly coreModelId: string,
    readonly issues: readonly ModelOptionsValidationIssue[],
  ) {
    super(`Options are invalid for model ${coreModelId}: ${issues.map((issue) => issue.message).join('; ')}`);
    this.name = 'CoreModelOptionsValidationError';
  }
}

let modelConstraintsConfig = modelConstraintsJson as unknown as ModelConstraintsConfig;

const MODEL_OPTION_CONSTRAINTS = new Map<string, ModelOptionsConstraintSet>();

loadOptionConstraintsFromConfig(modelConstraintsConfig);

export let MODEL_CONSTRAINTS_CONFIG: ModelConstraintsConfig = modelConstraintsConfig;

export function getModelConstraintsConfig(): ModelConstraintsConfig {
  return modelConstraintsConfig;
}

export function updateModelConstraintsConfig(config: ModelConstraintsConfig): void {
  modelConstraintsConfig = config;
  MODEL_CONSTRAINTS_CONFIG = config;
  MODEL_OPTION_CONSTRAINTS.clear();
  loadOptionConstraintsFromConfig(config);
}

export function getModelConstraints(modelId: string, displayName?: string): ModelConstraints | undefined {
  return modelConstraintsConfig.models[modelId]
    ?? (displayName ? modelConstraintsConfig.models[displayName] : undefined)
    ?? modelConstraintsConfig.models._default;
}

export function getProviderEntry(providerId: string): ProviderEntry | undefined {
  return modelConstraintsConfig.providers[providerId];
}

export function registerCoreModelOptionConstraints(
  coreModelId: string,
  constraints: ModelOptionsConstraintSet,
): ModelOptionsConstraintSet {
  MODEL_OPTION_CONSTRAINTS.set(normalizeCoreModelId(coreModelId), constraints);
  return constraints;
}

export function getCoreModelOptionConstraints(coreModelId: string): ModelOptionsConstraintSet | undefined {
  return MODEL_OPTION_CONSTRAINTS.get(normalizeCoreModelId(coreModelId));
}

export function listCoreModelOptionConstraints(): Record<string, ModelOptionsConstraintSet> {
  return Object.fromEntries(MODEL_OPTION_CONSTRAINTS.entries());
}

export function validateCoreModelOptions<TOptions extends Record<string, unknown>>(
  coreModelId: string,
  options: TOptions,
): TOptions {
  const constraints = MODEL_OPTION_CONSTRAINTS.get(normalizeCoreModelId(coreModelId));
  if (!constraints) {
    return options;
  }

  return validateOptionsAgainstConstraintSet(coreModelId, options, constraints);
}

export function validateOptionsAgainstConstraintSet<TOptions extends Record<string, unknown>>(
  coreModelId: string,
  options: TOptions,
  constraints: ModelOptionsConstraintSet,
): TOptions {
  const issues: ModelOptionsValidationIssue[] = [];
  const fields = constraints.fields;

  for (const [field, constraint] of Object.entries(fields)) {
    const value = options[field];

    if (value === undefined) {
      if (constraint.required) {
        issues.push({
          path: field,
          code: 'required',
          message: `${field} is required`,
        });
      }
      continue;
    }

    validateField(field, value, constraint, issues);
  }

  if (constraints.strict) {
    for (const field of Object.keys(options)) {
      if (!(field in fields)) {
        issues.push({
          path: field,
          code: 'unknown_field',
          message: `${field} is not allowed`,
        });
      }
    }
  }

  if (issues.length > 0) {
    throw new CoreModelOptionsValidationError(coreModelId, issues);
  }

  return options;
}

function normalizeCoreModelId(coreModelId: string): string {
  return coreModelId.trim();
}

function loadOptionConstraintsFromConfig(config: ModelConstraintsConfig): void {
  for (const [modelId, constraints] of Object.entries(config.models)) {
    const optionConstraints = optionConstraintsFromParams(constraints.params);
    if (optionConstraints) {
      MODEL_OPTION_CONSTRAINTS.set(modelId, optionConstraints);
    }
  }
}

function optionConstraintsFromParams(params: Record<string, unknown> | undefined): ModelOptionsConstraintSet | undefined {
  if (!params) {
    return undefined;
  }

  const fields: Record<string, ModelOptionFieldConstraint> = {};
  for (const [field, rawConstraint] of Object.entries(params)) {
    if (!isRecord(rawConstraint)) {
      continue;
    }

    const type = toOptionValueType(rawConstraint.type);
    if (!type) {
      continue;
    }

    const constraint: ModelOptionFieldConstraint = { type };
    if (rawConstraint.required === true) constraint.required = true;
    if (Array.isArray(rawConstraint.enum)) constraint.enum = rawConstraint.enum.filter(isEnumValue);
    if (typeof rawConstraint.min === 'number') constraint.min = rawConstraint.min;
    if (typeof rawConstraint.max === 'number') constraint.max = rawConstraint.max;
    if (typeof rawConstraint.minLength === 'number') constraint.minLength = rawConstraint.minLength;
    if (typeof rawConstraint.maxLength === 'number') constraint.maxLength = rawConstraint.maxLength;
    const itemType = toOptionValueType(rawConstraint.itemType);
    if (itemType) constraint.itemType = itemType;

    fields[field] = constraint;
  }

  return { fields };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toOptionValueType(value: unknown): ModelOptionValueType | undefined {
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

function isEnumValue(value: unknown): value is ModelOptionEnumValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function validateField(
  field: string,
  value: unknown,
  constraint: ModelOptionFieldConstraint,
  issues: ModelOptionsValidationIssue[],
): void {
  if (!matchesType(value, constraint.type)) {
    issues.push({
      path: field,
      code: 'invalid_type',
      message: `${field} must be ${constraint.type}`,
    });
    return;
  }

  if (constraint.enum && !constraint.enum.some((allowed) => Object.is(allowed, value))) {
    issues.push({
      path: field,
      code: 'invalid_enum',
      message: `${field} must be one of: ${constraint.enum.map(String).join(', ')}`,
    });
  }

  if (typeof value === 'number') {
    validateNumber(field, value, constraint, issues);
  }

  if (typeof value === 'string') {
    validateString(field, value, constraint, issues);
  }

  if (Array.isArray(value) && constraint.itemType) {
    validateArrayItems(field, value, constraint.itemType, issues);
  }
}

function validateNumber(
  field: string,
  value: number,
  constraint: ModelOptionFieldConstraint,
  issues: ModelOptionsValidationIssue[],
): void {
  if (constraint.min !== undefined && value < constraint.min) {
    issues.push({
      path: field,
      code: 'number_too_small',
      message: `${field} must be greater than or equal to ${constraint.min}`,
    });
  }

  if (constraint.max !== undefined && value > constraint.max) {
    issues.push({
      path: field,
      code: 'number_too_large',
      message: `${field} must be less than or equal to ${constraint.max}`,
    });
  }
}

function validateString(
  field: string,
  value: string,
  constraint: ModelOptionFieldConstraint,
  issues: ModelOptionsValidationIssue[],
): void {
  if (constraint.minLength !== undefined && value.length < constraint.minLength) {
    issues.push({
      path: field,
      code: 'string_too_short',
      message: `${field} must be at least ${constraint.minLength} characters`,
    });
  }

  if (constraint.maxLength !== undefined && value.length > constraint.maxLength) {
    issues.push({
      path: field,
      code: 'string_too_long',
      message: `${field} must be at most ${constraint.maxLength} characters`,
    });
  }
}

function validateArrayItems(
  field: string,
  value: readonly unknown[],
  itemType: ModelOptionValueType,
  issues: ModelOptionsValidationIssue[],
): void {
  value.forEach((item, index) => {
    if (!matchesType(item, itemType)) {
      issues.push({
        path: `${field}.${index}`,
        code: 'invalid_type',
        message: `${field}.${index} must be ${itemType}`,
      });
    }
  });
}

function matchesType(value: unknown, type: ModelOptionValueType): boolean {
  if (type === 'array') {
    return Array.isArray(value);
  }
  if (type === 'object') {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  if (type === 'null') {
    return value === null;
  }
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  return typeof value === type;
}
