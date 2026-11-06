import { type ProviderWebhookHandler, type ProviderWebhookQueue } from '@novelcomic/runtime';
import type { Db } from 'mongodb';
import type { logger as apiLogger } from '@novelcomic/observability';
import type { FastifyInstance, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from 'fastify';
type ApiFastifyInstance = FastifyInstance<RawServerDefault, RawRequestDefaultExpression<RawServerDefault>, RawReplyDefaultExpression<RawServerDefault>, typeof apiLogger>;
export interface RegisterProviderWebhookRoutesOptions {
    service?: ProviderWebhookHandler;
    tencentSignKey?: string;
    db?: Db;
    providerExecutionQueue?: ProviderWebhookQueue;
    artifactProcessingQueue?: ProviderWebhookQueue;
}
export declare function registerProviderWebhookRoutes(app: ApiFastifyInstance, options?: RegisterProviderWebhookRoutesOptions): Promise<void>;
export {};
