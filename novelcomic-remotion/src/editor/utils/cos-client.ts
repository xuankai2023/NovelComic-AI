import COS from 'cos-nodejs-sdk-v5';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {getServerEnv} from './server-env';

type COSClient = InstanceType<typeof COS>;

type COSConfig = {
	secretId: string;
	secretKey: string;
	region: string;
	bucket: string;
	cdnDomain: string;
	accelerateDomain?: string;
};

let cachedClient: COSClient | null = null;

export class COSConfigurationError extends Error {
	public readonly missingKeys: string[];

	constructor(missingKeys: string[]) {
		super(
			`COS environment variables are missing: ${missingKeys.join(', ')}`,
		);
		this.name = 'COSConfigurationError';
		this.missingKeys = missingKeys;
	}
}

const normalizeDomain = (domain: string) =>
	domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');

const readLocalEnv = () => {
	try {
		const contents = readFileSync(join(process.cwd(), '.env'), 'utf8');
		return Object.fromEntries(
			contents
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith('#'))
				.flatMap((line) => {
					const separatorIndex = line.indexOf('=');
					if (separatorIndex === -1) return [];

					const key = line.slice(0, separatorIndex).trim();
					const rawValue = line.slice(separatorIndex + 1).trim();
					const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');
					return [[key, value]];
				}),
		);
	} catch {
		return {};
	}
};

const getEnvValue = (
	env: ReturnType<typeof getServerEnv>,
	key: keyof ReturnType<typeof getServerEnv>,
) => {
	const value = env[key];
	if (typeof value === 'string' && value.length > 0) {
		return value;
	}

	return readLocalEnv()[key];
};

const requireCOSConfig = (): COSConfig => {
	const env = getServerEnv();
	const missing: string[] = [];
	const secretId = getEnvValue(env, 'COS_SECRET_ID');
	const secretKey = getEnvValue(env, 'COS_SECRET_KEY');
	const region = getEnvValue(env, 'COS_REGION');
	const bucket = getEnvValue(env, 'COS_BUCKET');
	const cdnDomain =
		getEnvValue(env, 'COS_CDN_DOMAIN') ?? getEnvValue(env, 'REMOTION_CDN_URL');
	const accelerateDomain = getEnvValue(env, 'COS_ACCELERATE_DOMAIN');

	if (!secretId) missing.push('COS_SECRET_ID');
	if (!secretKey) missing.push('COS_SECRET_KEY');
	if (!region) missing.push('COS_REGION');
	if (!bucket) missing.push('COS_BUCKET');
	if (!cdnDomain) missing.push('COS_CDN_DOMAIN or REMOTION_CDN_URL');

	if (missing.length > 0) {
		throw new COSConfigurationError(missing);
	}

	return {
		secretId: secretId!,
		secretKey: secretKey!,
		region: region!,
		bucket: bucket!,
		cdnDomain: cdnDomain!,
		accelerateDomain: accelerateDomain
			? normalizeDomain(accelerateDomain)
			: undefined,
	};
};

const getCOSClient = () => {
	if (cachedClient) return cachedClient;

	const config = requireCOSConfig();
	cachedClient = new COS({
		SecretId: config.secretId,
		SecretKey: config.secretKey,
	});

	return cachedClient;
};

/** Prefer global accelerate endpoint for cross-region (e.g. Vercel → HK COS). */
const cosEndpointOptions = (config: COSConfig) =>
	config.accelerateDomain
		? {Domain: config.accelerateDomain}
		: {UseAccelerate: false as const};

export const getCOSReadUrl = (key: string) => {
	const config = requireCOSConfig();
	const base = config.cdnDomain.replace(/\/+$/, '');
	return `${base}/${key}`;
};

export const getCOSPresignedPutUrl = ({
	key,
	expiresInSeconds,
}: {
	key: string;
	contentType: string;
	contentLength: number;
	expiresInSeconds: number;
}) => {
	const config = requireCOSConfig();
	const client = getCOSClient();

	return client.getObjectUrl({
		Bucket: config.bucket,
		Region: config.region,
		Key: key,
		Method: 'PUT',
		Sign: true,
		Expires: expiresInSeconds,
		Protocol: 'https:',
		...cosEndpointOptions(config),
	});
};

export const getCOSObjectBuffer = async (key: string): Promise<Buffer> => {
	const config = requireCOSConfig();
	const client = getCOSClient();
	const data = await client.getObject({
		Bucket: config.bucket,
		Region: config.region,
		Key: key,
		...cosEndpointOptions(config),
	});

	return data.Body;
};

export const putCOSObject = async ({
	key,
	body,
	contentType,
}: {
	key: string;
	body: Buffer;
	contentType: string;
}) => {
	const config = requireCOSConfig();
	const client = getCOSClient();

	await client.putObject({
		Bucket: config.bucket,
		Region: config.region,
		Key: key,
		Body: body,
		ContentLength: body.length,
		ContentType: contentType,
		CacheControl: 'public, max-age=31536000',
		...cosEndpointOptions(config),
	});
};

export const deleteCOSObject = async (key: string) => {
	const config = requireCOSConfig();
	const client = getCOSClient();

	await client.deleteObject({
		Bucket: config.bucket,
		Region: config.region,
		Key: key,
		...cosEndpointOptions(config),
	});
};
