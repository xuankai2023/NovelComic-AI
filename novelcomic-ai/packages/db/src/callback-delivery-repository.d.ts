import type { AiCallbackDeliveryDocument } from '@novelcomic/contracts';
import type { Collection, Db } from 'mongodb';
export declare const AI_CALLBACK_DELIVERY_COLLECTION_NAME: "ai_callback_delivery";
export interface CallbackDeliveryRepositoryOptions {
    collectionName?: string;
}
export declare class CallbackDeliveryRepository {
    private readonly collection;
    constructor(dbOrCollection: Db | Collection<AiCallbackDeliveryDocument>, options?: CallbackDeliveryRepositoryOptions);
    ensureIndexes(): Promise<void>;
    upsertDelivery(delivery: AiCallbackDeliveryDocument): Promise<void>;
    listByTask(aiTaskId: string): Promise<AiCallbackDeliveryDocument[]>;
}
