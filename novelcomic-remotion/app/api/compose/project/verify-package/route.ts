import {z} from 'zod';
import {
	COMIC_ERROR_CODES,
	ComicEditorError,
} from '../../../../../src/editor/comic/errors';
import {verifyDeliveryPackage} from '../../../../../src/editor/comic/verify-package';
import {runComposeRoute} from '../../../../../src/editor/compose/http-response';
import {
	projectBaseSchema,
	remoteUrlSchema,
} from '../../../../../src/editor/compose/schemas';
import {
	resolveAllowedHosts,
	validateRemoteUrl,
} from '../../../../../src/editor/compose/validate-remote-url';

export const runtime = 'nodejs';

const requestSchema = z.object({
	packageUrl: remoteUrlSchema,
});

const dependencyError = (message: string): ComicEditorError =>
	new ComicEditorError({
		code: COMIC_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
		message,
		retryable: true,
		status: 503,
	});

export async function POST(request: Request) {
	return runComposeRoute(request, async (body) => {
		const input = requestSchema.parse(body);
		const packageUrl = validateRemoteUrl(input.packageUrl, {
			allowedHosts: resolveAllowedHosts(),
		});
		let response: Response;
		try {
			response = await fetch(packageUrl, {cache: 'no-store'});
		} catch (error) {
			throw dependencyError(
				error instanceof Error
					? `Could not download delivery package: ${error.message}`
					: 'Could not download delivery package',
			);
		}
		if (!response.ok) {
			throw dependencyError(
				`Could not download delivery package: HTTP ${response.status}`,
			);
		}

		let archive: Buffer;
		try {
			archive = Buffer.from(await response.arrayBuffer());
		} catch {
			throw dependencyError('Could not read delivery package bytes');
		}

		const verification = verifyDeliveryPackage(archive);
		return {
			...verification,
			project: projectBaseSchema.parse(verification.project),
		};
	});
}
