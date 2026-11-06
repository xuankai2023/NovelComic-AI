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
    label: {
        zh: string;
        en: string;
    };
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
    code: 'required' | 'unknown_field' | 'invalid_type' | 'invalid_enum' | 'number_too_small' | 'number_too_large' | 'string_too_short' | 'string_too_long';
    message: string;
}
export declare class CoreModelOptionsValidationError extends Error {
    readonly coreModelId: string;
    readonly issues: readonly ModelOptionsValidationIssue[];
    readonly code = "MODEL_OPTIONS_INVALID";
    constructor(coreModelId: string, issues: readonly ModelOptionsValidationIssue[]);
}
export declare let MODEL_CONSTRAINTS_CONFIG: ModelConstraintsConfig;
export declare function getModelConstraintsConfig(): ModelConstraintsConfig;
export declare function updateModelConstraintsConfig(config: ModelConstraintsConfig): void;
export declare function getModelConstraints(modelId: string, displayName?: string): ModelConstraints | undefined;
export declare function getProviderEntry(providerId: string): ProviderEntry | undefined;
export declare function registerCoreModelOptionConstraints(coreModelId: string, constraints: ModelOptionsConstraintSet): ModelOptionsConstraintSet;
export declare function getCoreModelOptionConstraints(coreModelId: string): ModelOptionsConstraintSet | undefined;
export declare function listCoreModelOptionConstraints(): Record<string, ModelOptionsConstraintSet>;
export declare function validateCoreModelOptions<TOptions extends Record<string, unknown>>(coreModelId: string, options: TOptions): TOptions;
export declare function validateOptionsAgainstConstraintSet<TOptions extends Record<string, unknown>>(coreModelId: string, options: TOptions, constraints: ModelOptionsConstraintSet): TOptions;
