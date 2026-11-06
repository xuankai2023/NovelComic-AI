import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { AppConfig } from '@novelcomic/config';

export interface ObjectStorage {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export interface ArtifactUploader {
  uploadRemoteUrl(remoteUrl: string, options?: { contentType?: string; filename?: string }): Promise<string>;
}

export const passThroughUploader: ArtifactUploader = {
  async uploadRemoteUrl(remoteUrl: string): Promise<string> {
    return remoteUrl;
  },
};

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

export class DefaultArtifactStore implements ArtifactStore {
  public constructor(
    private readonly uploader: ArtifactUploader = passThroughUploader,
    private readonly config: Pick<AppConfig, 'ARTIFACT_BASE_URL'> = {},
  ) {}

  public async processResult(result: unknown): Promise<unknown> {
    if (!isRecord(result)) {
      return result;
    }

    const processed: Record<string, unknown> = { ...result };
    if (Array.isArray(result.artifacts)) {
      processed.artifacts = await Promise.all(result.artifacts.map((artifact) => this.processArtifact(artifact)));
    }

    if (!this.config.ARTIFACT_BASE_URL) {
      return processed;
    }

    const metadata = isRecord((result as Record<string, unknown>).metadata)
      ? { ...(result as { metadata: Record<string, unknown> }).metadata }
      : {};
    return {
      ...processed,
      metadata: {
        ...metadata,
        artifact_base_url: this.config.ARTIFACT_BASE_URL,
      },
    };
  }

  private async processArtifact(artifact: unknown): Promise<unknown> {
    if (!isArtifactRecord(artifact)) {
      return artifact;
    }
    if (!isRemoteUrl(artifact.url)) {
      return artifact;
    }
    return {
      ...artifact,
      url: await this.uploader.uploadRemoteUrl(artifact.url, {
        ...(artifact.mime_type ? { contentType: artifact.mime_type } : {}),
        filename: artifact.url.split('/').filter(Boolean).at(-1) ?? 'artifact',
      }),
    };
  }
}

export class PassThroughArtifactStore extends DefaultArtifactStore {
  public constructor(config: Pick<AppConfig, 'ARTIFACT_BASE_URL'> = {}) {
    super(passThroughUploader, config);
  }
}

export function createArtifactUploader(config: AppConfig, fetchImpl: typeof fetch = fetch): ArtifactUploader {
  switch (config.ARTIFACT_STORAGE_PROVIDER) {
    case 'cos':
      assertCosConfigured(config);
      return new CosArtifactUploader(config, fetchImpl);
    case 's3':
      assertS3Configured(config);
      return new S3ArtifactUploader(config, fetchImpl);
    case 'pass_through':
      return passThroughUploader;
  }
}

export class CosArtifactUploader implements ArtifactUploader {
  public constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    assertCosConfigured(config);
  }

  public async uploadRemoteUrl(
    remoteUrl: string,
    options: { contentType?: string; filename?: string } = {},
  ): Promise<string> {
    const downloaded = await downloadRemoteArtifact(remoteUrl, this.fetchImpl);
    const contentType = options.contentType ?? downloaded.contentType ?? 'application/octet-stream';
    const objectKey = createArtifactObjectKey(remoteUrl, contentType, options.filename);
    const bucket = String(this.config.COS_BUCKET).trim();
    const region = String(this.config.COS_REGION).trim();
    const secretId = String(this.config.COS_SECRET_ID).trim();
    const secretKey = String(this.config.COS_SECRET_KEY).trim();
    const cdnDomain = String(this.config.COS_CDN_DOMAIN).trim().replace(/\/+$/, '');

    const host = `${bucket}.cos.${region}.myqcloud.com`;
    const authorization = buildCosAuthorization({
      secretId,
      secretKey,
      method: 'PUT',
      objectKey,
      host,
    });

    const uploadUrl = `https://${host}/${objectKey}`;
    const response = await this.fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: {
        Host: host,
        Authorization: authorization,
        'Content-Type': contentType,
        'Content-Length': String(downloaded.body.byteLength),
      },
      body: new Uint8Array(downloaded.body),
    });

    if (!response.ok) {
      throw new Error(`COS artifact upload failed with HTTP ${response.status}`);
    }

    const baseUrl = /^https?:\/\//i.test(cdnDomain) ? cdnDomain : `https://${cdnDomain}`;
    return `${baseUrl}/${objectKey}`;
  }
}

export class S3ArtifactUploader implements ArtifactUploader {
  public constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    assertS3Configured(config);
  }

  public async uploadRemoteUrl(
    remoteUrl: string,
    options: { contentType?: string; filename?: string } = {},
  ): Promise<string> {
    const downloaded = await downloadRemoteArtifact(remoteUrl, this.fetchImpl);
    const contentType = options.contentType ?? downloaded.contentType ?? 'application/octet-stream';
    const objectKey = createArtifactObjectKey(remoteUrl, contentType, options.filename);
    const bucket = String(this.config.ARTIFACT_BUCKET ?? this.config.S3_BUCKET).trim();
    const accessKeyId = String(this.config.ARTIFACT_ACCESS_KEY_ID ?? this.config.S3_ACCESS_KEY).trim();
    const secretAccessKey = String(this.config.ARTIFACT_SECRET_ACCESS_KEY ?? this.config.S3_SECRET_KEY).trim();
    const publicBaseUrl = String(this.config.ARTIFACT_BASE_URL ?? this.config.S3_DOMAIN).trim().replace(/\/+$/, '');
    const region = 'us-east-1';

    const host = `${bucket}.s3.${region}.amazonaws.com`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256').update(downloaded.body).digest('hex');
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [
      'PUT',
      `/${objectKey}`,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
    const kRegion = createHmac('sha256', kDate).update(region).digest();
    const kService = createHmac('sha256', kRegion).update('s3').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const uploadUrl = `https://${host}/${objectKey}`;
    const response = await this.fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: {
        Host: host,
        Authorization: authorization,
        'Content-Type': contentType,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
      },
      body: new Uint8Array(downloaded.body),
    });

    if (!response.ok) {
      throw new Error(`S3 artifact upload failed with HTTP ${response.status}`);
    }

    const baseUrl = /^https?:\/\//i.test(publicBaseUrl) ? publicBaseUrl : `https://${publicBaseUrl}`;
    return `${baseUrl}/${objectKey}`;
  }
}

async function downloadRemoteArtifact(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ body: Buffer; contentType: string | null }> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) {
    throw new Error(`Failed to download artifact: ${response.status} ${url}`);
  }
  const contentType = response.headers.get('content-type');
  const body = Buffer.from(await response.arrayBuffer());
  return { body, contentType };
}

function createArtifactObjectKey(url: string, contentType: string | null, filename?: string): string {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const randomId = randomBytes(8).toString('hex');
  const ext = resolveArtifactExtension(filename ?? url, contentType);
  const prefix = resolveArtifactPrefix(contentType, ext);
  return `${prefix}/${year}/${month}/result-${Date.now()}-${randomId}.${ext}`;
}

function resolveArtifactPrefix(contentType: string | null, ext: string): string {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('video') || ext === 'mp4' || ext === 'webm') return 'videos';
  if (ct.includes('audio') || ext === 'mp3' || ext === 'wav') return 'audios';
  if (ct.includes('image') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'images';
  return 'artifacts';
}

function resolveArtifactExtension(urlOrName: string, contentType: string | null): string {
  const clean = urlOrName.split('?')[0]?.split('#')[0] ?? '';
  const fromUrl = clean.split('.').pop();
  if (fromUrl && fromUrl.length <= 4 && /^[a-z0-9]+$/i.test(fromUrl)) {
    return fromUrl.toLowerCase();
  }
  if (contentType) {
    if (contentType.includes('mp4')) return 'mp4';
    if (contentType.includes('webm')) return 'webm';
    if (contentType.includes('png')) return 'png';
    if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
    if (contentType.includes('gif')) return 'gif';
    if (contentType.includes('webp')) return 'webp';
    if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3';
    if (contentType.includes('wav')) return 'wav';
  }
  return 'bin';
}

function buildCosAuthorization(input: {
  secretId: string;
  secretKey: string;
  method: string;
  objectKey: string;
  host: string;
}): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const keyTime = `${nowSec - 60};${nowSec + 900}`;
  const signKey = createHmac('sha1', input.secretKey).update(keyTime).digest('hex');
  const httpString = `${input.method.toLowerCase()}\n/${input.objectKey.replace(/^\/+/, '')}\n\nhost=${encodeURIComponent(input.host).toLowerCase()}\n`;
  const sha1Http = createHash('sha1').update(httpString).digest('hex');
  const stringToSign = `sha1\n${keyTime}\n${sha1Http}\n`;
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex');
  return [
    'q-sign-algorithm=sha1',
    `q-ak=${input.secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    'q-header-list=host',
    'q-url-param-list=',
    `q-signature=${signature}`,
  ].join('&');
}

function assertCosConfigured(config: AppConfig): void {
  const missing = [
    ['COS_SECRET_ID', config.COS_SECRET_ID],
    ['COS_SECRET_KEY', config.COS_SECRET_KEY],
    ['COS_REGION', config.COS_REGION],
    ['COS_BUCKET', config.COS_BUCKET],
    ['COS_CDN_DOMAIN', config.COS_CDN_DOMAIN],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`COS artifact uploader is not configured: missing ${missing.join(', ')}`);
  }
}

function assertS3Configured(config: AppConfig): void {
  const missing = [
    ['ARTIFACT_BASE_URL or S3_DOMAIN', config.ARTIFACT_BASE_URL ?? config.S3_DOMAIN],
    ['ARTIFACT_BUCKET or S3_BUCKET', config.ARTIFACT_BUCKET ?? config.S3_BUCKET],
    ['ARTIFACT_ACCESS_KEY_ID or S3_ACCESS_KEY', config.ARTIFACT_ACCESS_KEY_ID ?? config.S3_ACCESS_KEY],
    ['ARTIFACT_SECRET_ACCESS_KEY or S3_SECRET_KEY', config.ARTIFACT_SECRET_ACCESS_KEY ?? config.S3_SECRET_KEY],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`S3 artifact uploader is not configured: missing ${missing.join(', ')}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isArtifactRecord(value: unknown): value is NormalizedArtifact {
  return isRecord(value) && typeof value.url === 'string';
}

function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
