import type { AppConfig } from '@novelcomic/config';
export interface ObjectStorage {
    put(key: string, data: Uint8Array): Promise<void>;
    get(key: string): Promise<Uint8Array | null>;
}
export interface ArtifactUploader {
    uploadRemoteUrl(remoteUrl: string, options?: {
        contentType?: string;
        filename?: string;
    }): Promise<string>;
}
export declare const passThroughUploader: ArtifactUploader;
export interface ArtifactStore {
    processResult(result: unknown): Promise<unknown>;
}
export interface NormalizedArtifact {
    type?: string;
    url: string;
    mime_type?: string;
    file_size?: number;
    width?: number;
    height?: number;
    duration_seconds?: number;
    aspect_ratio?: string;
}
export declare class DefaultArtifactStore implements ArtifactStore {
    private readonly uploader;
    private readonly config;
    constructor(uploader?: ArtifactUploader, config?: Pick<AppConfig, 'ARTIFACT_BASE_URL'>);
    processResult(result: unknown): Promise<unknown>;
    private processArtifact;
}
export declare class PassThroughArtifactStore extends DefaultArtifactStore {
    constructor(config?: Pick<AppConfig, 'ARTIFACT_BASE_URL'>);
}
export declare function createArtifactUploader(config: AppConfig): ArtifactUploader;
