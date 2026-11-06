import type { logger as apiLogger } from '@novelcomic/observability';
import { type TaskSubmitQueue } from '@novelcomic/runtime';
import type { FastifyInstance, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from 'fastify';
import type { Db } from 'mongodb';
type ApiFastifyInstance = FastifyInstance<RawServerDefault, RawRequestDefaultExpression<RawServerDefault>, RawReplyDefaultExpression<RawServerDefault>, typeof apiLogger>;
export interface RegisterTaskRoutesOptions {
    db: Db;
    providerExecutionQueue: TaskSubmitQueue;
}
export declare function registerTaskRoutes(app: ApiFastifyInstance, options: RegisterTaskRoutesOptions): Promise<void>;
export {};
