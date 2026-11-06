import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';
import {GOOGLE_FONTS_DATABASE} from '../data/google-fonts';
import type {ComposeCapabilities} from './render-preflight';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

type CapabilityEnvironment = Record<string, string | undefined>;
type CapabilityChecks = {
	localRenderer?: () => boolean;
	ffmpeg?: (executable: string) => Promise<boolean>;
};

const hasValue = (env: CapabilityEnvironment, key: string) =>
	typeof env[key] === 'string' && env[key]!.trim().length > 0;

const defaultLocalRendererCheck = () => {
	try {
		require.resolve('@remotion/renderer');
		require.resolve('@remotion/bundler');
		return true;
	} catch {
		return false;
	}
};

const defaultFfmpegCheck = async (executable: string) => {
	try {
		await execFileAsync(executable, ['-version'], {timeout: 3000});
		return true;
	} catch {
		return false;
	}
};

export const inspectComposeCapabilities = async ({
	env = process.env,
	fonts = [],
	checks = {},
}: {
	env?: CapabilityEnvironment;
	fonts?: string[];
	checks?: CapabilityChecks;
} = {}): Promise<ComposeCapabilities> => {
	const backend = env.REMOTION_RENDER_BACKEND === 'local' ? 'local' : 'lambda';
	const localAvailable = (checks.localRenderer ?? defaultLocalRendererCheck)();
	const lambdaMissing = [
		'REMOTION_AWS_REGION',
		'REMOTION_AWS_BUCKET_NAME',
	].filter((key) => !hasValue(env, key));
	const cosMissing = [
		'COS_SECRET_ID',
		'COS_SECRET_KEY',
		'COS_REGION',
		'COS_BUCKET',
	].filter((key) => !hasValue(env, key));
	if (!hasValue(env, 'COS_CDN_DOMAIN') && !hasValue(env, 'REMOTION_CDN_URL')) {
		cosMissing.push('COS_CDN_DOMAIN or REMOTION_CDN_URL');
	}
	const ffmpegExecutable = env.FFMPEG_PATH?.trim() || 'ffmpeg';
	const ffmpegAvailable = await (checks.ffmpeg ?? defaultFfmpegCheck)(
		ffmpegExecutable,
	);
	const knownFonts = new Set(
		GOOGLE_FONTS_DATABASE.map((font) => font.fontFamily),
	);
	const missingFonts = [...new Set(fonts)]
		.filter((font) => font && !knownFonts.has(font))
		.sort();
	const cosConfigured = cosMissing.length === 0;

	return {
		renderBackend: backend,
		local: localAvailable
			? {available: true}
			: {
					available: false,
					reason: 'The Remotion renderer or bundler package is unavailable.',
				},
		lambda:
			lambdaMissing.length === 0
				? {configured: true}
				: {
						configured: false,
						reason: `Missing Lambda configuration: ${lambdaMissing.join(', ')}.`,
					},
		ffmpeg: ffmpegAvailable
			? {available: true}
			: {
					available: false,
					reason: `Could not execute ${ffmpegExecutable}.`,
				},
		cos: cosConfigured
			? {configured: true}
			: {
					configured: false,
					reason: `Missing COS configuration: ${cosMissing.join(', ')}.`,
				},
		fonts:
			missingFonts.length === 0
				? {available: true}
				: {available: false, missing: missingFonts},
		exportPackage: cosConfigured
			? {available: true}
			: {
					available: false,
					reason: 'Package upload requires a complete COS configuration.',
				},
	};
};
