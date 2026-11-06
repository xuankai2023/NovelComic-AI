import type { CoreProvider } from './types.js';

export const SERVICE_NAME = 'novelcomic';

export {
  CORE_MODELS,
  CoreProviderCallNotFoundError,
  CoreProviderSubmitError,
  CoreProviderNotAvailableError,
  CoreModelNotRegisteredError,
  extractRequestedProviderFromOptions,
  getRemainingRobinProviders,
  listCoreModels,
  registerCoreModel,
  requireCoreModel,
  resolveCoreModelId,
  stripProviderFromOptions,
  parseCoreProviderWebhook,
  submitCoreTask,
  validateCoreModelOptions,
  verifyTencentWebhookSignature,
  type CoreModelEntity,
  type ParsedCoreProviderWebhook,
  type SubmitCoreTaskInput,
} from './model-runtime.js';
export {
  type CoreProvider,
  type CoreProviderCall,
  type CoreProviderResult,
  type CoreProviderResultMode,
  type CoreProviderResultStatus,
  type CoreRunContext,
  type CoreSubmitInput,
  type CoreSubmitResult,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
} from './types.js';
export {
  CoreModelOptionsValidationError,
  getCoreModelOptionConstraints,
  getModelConstraints,
  getModelConstraintsConfig,
  getProviderEntry,
  listCoreModelOptionConstraints,
  MODEL_CONSTRAINTS_CONFIG,
  registerCoreModelOptionConstraints,
  updateModelConstraintsConfig,
  validateOptionsAgainstConstraintSet,
  type ModelOptionEnumValue,
  type ModelOptionFieldConstraint,
  type ModelConstraints,
  type ModelConstraintsConfig,
  type ModelOptionsConstraintSet,
  type ModelOptionsValidationIssue,
  type ModelOptionValueType,
  type ProviderEntry,
  type ProviderRetryConfig,
} from './model-constraints.js';
export {
  DEFAULT_KIE_BASE_URL,
  KieProviderClient,
  KieProviderRequestError,
  type KieCancelInput,
  type KieClientConfig,
  type KieGetResultInput,
  type KieResponseBody,
  type KieSubmitInput,
} from './provider/kie_client.js';
export {
  AgentFactory,
  type AgentFactoryOptions,
  type LoadSkillToolFactory,
  type SubagentToolFactory,
} from './factory.js';
export {
  ProfileRegistry,
  type AgentContext,
  type AgentInstance,
  type AgentProfile,
  type SkillsLoaderLike,
  type SystemPromptFactory,
  type SystemPromptFactoryInput,
  type ToolFactory,
} from './profile.js';
export { Tool, ToolResult, type FunctionToolSchema, type JsonSchema, type JsonSchemaType } from './tools/base.js';
export { ToolRegistry } from './tools/registry.js';

export interface ArtifactUploader {
  uploadRemoteUrl(remoteUrl: string, options?: { contentType?: string; filename?: string }): Promise<string>;
}

export const passThroughUploader: ArtifactUploader = {
  async uploadRemoteUrl(remoteUrl: string): Promise<string> {
    return remoteUrl;
  },
};

export type MediaAssetResolveResult =
  | { status: 'resolved'; provider: 'byteplus'; media_url: string; asset_id: string; asset_uri: string }
  | {
      status: 'not_ready';
      provider: 'byteplus';
      media_url: string;
      asset_id: string;
      verification_status?: string;
      sync_status?: string;
    }
  | { status: 'not_found' };

export interface MediaAssetResolver {
  resolveUrl(input: { provider: CoreProvider; media_url: string }): Promise<MediaAssetResolveResult>;
}
