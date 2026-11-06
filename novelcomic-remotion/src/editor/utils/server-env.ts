import {AwsRegion} from '@remotion/lambda';
import {z} from 'zod';

const serverEnvSchema = z.object({
	REMOTION_AWS_BUCKET_NAME: z.string().optional(),
	REMOTION_AWS_REGION: z.custom<AwsRegion>().optional(),
	OPENAI_API_KEY: z.string().optional(),
	ELEVENLABS_API_KEY: z.string().optional(),
	DASHSCOPE_API_KEY: z.string().optional(),
	DASHSCOPE_API_BASE_URL: z.string().optional(),
	DASHSCOPE_IMAGE_EDIT_MODEL: z.string().optional(),
	DASHSCOPE_IMAGE_EDIT_POLL_INTERVAL_MS: z.string().optional(),
	DASHSCOPE_IMAGE_EDIT_TIMEOUT_MS: z.string().optional(),
	REMOTION_AWS_TRANSFER_ACCELERATION: z.string().optional(),
	REMOTION_CDN_URL: z.string().optional(),
	COS_SECRET_ID: z.string().optional(),
	COS_SECRET_KEY: z.string().optional(),
	COS_REGION: z.string().optional(),
	COS_BUCKET: z.string().optional(),
	COS_CDN_DOMAIN: z.string().optional(),
	COS_ACCELERATE_DOMAIN: z.string().optional(),
});

type ServerEnv = z.infer<typeof serverEnvSchema>;
type RenderServerEnv = ServerEnv & {
	REMOTION_AWS_BUCKET_NAME: string;
	REMOTION_AWS_REGION: AwsRegion;
};

let _cachedServerEnv: ServerEnv | null = null;
let _validationError: Error | null = null;

export const getServerEnv = (): ServerEnv => {
	if (_cachedServerEnv) {
		return _cachedServerEnv;
	}

	if (_validationError) {
		return {};
	}

	try {
		_cachedServerEnv = serverEnvSchema.parse(process.env);
		return _cachedServerEnv;
	} catch (error) {
		_validationError = error as Error;
		// eslint-disable-next-line no-console
		console.warn(
			'Server environment variables not configured:',
			error instanceof Error ? error.message : error,
		);
		return {};
	}
};

export const renderBackend = (): 'local' | 'lambda' => {
	const value = process.env.REMOTION_RENDER_BACKEND;
	if (value === undefined || value === '' || value === 'lambda') {
		return 'lambda';
	}

	if (value === 'local') {
		return 'local';
	}

	throw new Error('REMOTION_RENDER_BACKEND must be "local" or "lambda"');
};

export const requireServerEnv = (): RenderServerEnv => {
	const env = getServerEnv();
	if (!env.REMOTION_AWS_BUCKET_NAME || !env.REMOTION_AWS_REGION) {
		throw new Error(
			'Render environment variables are not configured. Please set REMOTION_AWS_BUCKET_NAME and REMOTION_AWS_REGION.',
		);
	}
	return env as RenderServerEnv;
};
