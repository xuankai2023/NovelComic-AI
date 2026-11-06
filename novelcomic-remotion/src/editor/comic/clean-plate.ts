import type {ImageAsset} from '../assets/assets';
import {getCOSReadUrl, putCOSObject} from '../utils/cos-client';
import {parseCleanPlateColor} from './clean-plate-fill';
import {COMIC_ERROR_CODES, ComicEditorError, domainInvariant} from './errors';

export const CLEAN_PLATE_INPAINT_MODES = [
	'solid-fill',
	'clone-fill',
	'opencv-inpaint',
	'ai-inpaint',
] as const;

export type CleanPlateInpaintMode = (typeof CLEAN_PLATE_INPAINT_MODES)[number];

export type CleanPlateInpaintInput = {
	projectId: string;
	shotId: string;
	sourceAssetId: string;
	maskAssetId: string;
	sourceUrl: string;
	maskUrl: string;
	canvas: {
		width: number;
		height: number;
	};
	mode: CleanPlateInpaintMode;
	version: number;
	fillColor?: string;
	cloneSource?: {
		x: number;
		y: number;
	};
	clientRequestId?: string;
};

export type CleanPlateDiagnostics = {
	alphaHoleRatio: number;
	edgeArtifactScore: number;
	recompositionScore: number;
	warnings: string[];
};

export type CleanPlateInpaintResult = {
	cleanPlateAsset: ImageAsset;
	diagnostics: CleanPlateDiagnostics;
};

const dependencyUnavailable = (message: string): ComicEditorError => {
	return new ComicEditorError({
		code: COMIC_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
		message,
		retryable: true,
		status: 503,
	});
};

const hasDashScopeCredentials = (): boolean =>
	Boolean(process.env.DASHSCOPE_API_KEY?.trim());

const dashScopeBaseUrl = (): string => {
	const value =
		process.env.DASHSCOPE_API_BASE_URL?.trim() ||
		'https://dashscope.aliyuncs.com/api/v1';
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:') throw new Error('HTTPS is required');
		return url.href.replace(/\/+$/, '');
	} catch {
		throw dependencyUnavailable(
			'DASHSCOPE_API_BASE_URL must be a valid HTTPS URL',
		);
	}
};

const dashScopeHeaders = (): HeadersInit => ({
	'content-type': 'application/json',
	accept: 'application/json',
	authorization: `Bearer ${process.env.DASHSCOPE_API_KEY!.trim()}`,
	'X-DashScope-Async': 'enable',
});

const readProviderBody = async (
	response: Response,
): Promise<Record<string, unknown>> => {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw dependencyUnavailable('Alibaba Bailian returned invalid JSON');
	}
	if (!response.ok || !isRecord(body)) {
		const message =
			isRecord(body) && isRecord(body.message)
				? String(body.message)
				: isRecord(body) && typeof body.message === 'string'
					? body.message
					: `Alibaba Bailian request failed with ${response.status}`;
		throw dependencyUnavailable(message);
	}
	return body;
};

const readDashScopeImageUrl = (
	body: Record<string, unknown>,
): string | null => {
	const output = isRecord(body.output) ? body.output : body;
	const results = Array.isArray(output.results) ? output.results : [];
	for (const result of results) {
		if (
			isRecord(result) &&
			typeof result.url === 'string' &&
			result.url.trim()
		) {
			return result.url;
		}
	}
	for (const key of ['image_url', 'url']) {
		if (typeof output[key] === 'string' && output[key].trim())
			return output[key];
	}
	if (Array.isArray(output.image_urls)) {
		const url = output.image_urls.find((value) => typeof value === 'string');
		if (url) return url;
	}
	return null;
};

const readDashScopeTaskId = (body: Record<string, unknown>): string | null => {
	const output = isRecord(body.output) ? body.output : body;
	return typeof output.task_id === 'string' && output.task_id.trim()
		? output.task_id
		: null;
};

const wait = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const fetchDashScopeImage = async (
	input: CleanPlateInpaintInput,
): Promise<{url: string; warnings: string[]}> => {
	if (input.canvas.width < 512 || input.canvas.height < 512) {
		throw dependencyUnavailable(
			`Alibaba Bailian Wan2.1 ImageEdit requires a canvas of at least 512x512; received ${input.canvas.width}x${input.canvas.height}. Pad or resize the source and mask before inpainting.`,
		);
	}
	const baseUrl = dashScopeBaseUrl();
	const model =
		process.env.DASHSCOPE_IMAGE_EDIT_MODEL?.trim() || 'wanx2.1-imageedit';
	const prompt =
		'Reconstruct the masked regions as a clean plate, preserve every unmasked pixel, ' +
		'and match the original canvas composition and dimensions.';
	const response = await fetch(
		`${baseUrl}/services/aigc/image-generation/generation`,
		{
			method: 'POST',
			headers: dashScopeHeaders(),
			body: JSON.stringify({
				model,
				input: {
					prompt,
					function: 'description_edit_with_mask',
					base_image_url: input.sourceUrl,
					mask_image_url: input.maskUrl,
				},
				parameters: {
					size: `${input.canvas.width}*${input.canvas.height}`,
					n: 1,
				},
			}),
		},
	);
	let body = await readProviderBody(response);
	let imageUrl = readDashScopeImageUrl(body);
	const taskId = readDashScopeTaskId(body);
	if (!imageUrl && taskId) {
		const configuredTimeout = Number(
			process.env.DASHSCOPE_IMAGE_EDIT_TIMEOUT_MS,
		);
		const configuredInterval = Number(
			process.env.DASHSCOPE_IMAGE_EDIT_POLL_INTERVAL_MS,
		);
		const timeoutMs = Math.max(
			5_000,
			Number.isFinite(configuredTimeout) ? configuredTimeout : 120_000,
		);
		const intervalMs = Math.max(
			0,
			Number.isFinite(configuredInterval) ? configuredInterval : 1_500,
		);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (intervalMs > 0) await wait(intervalMs);
			const statusResponse = await fetch(
				`${baseUrl}/tasks/${encodeURIComponent(taskId)}`,
				{
					headers: {
						accept: 'application/json',
						authorization: `Bearer ${process.env.DASHSCOPE_API_KEY!.trim()}`,
					},
				},
			);
			body = await readProviderBody(statusResponse);
			const output = isRecord(body.output) ? body.output : body;
			const status = String(
				output.task_status ?? body.task_status ?? '',
			).toUpperCase();
			imageUrl = readDashScopeImageUrl(body);
			if (imageUrl || status === 'SUCCEEDED') break;
			if (status === 'FAILED' || status === 'CANCELED') {
				throw dependencyUnavailable(
					`Alibaba Bailian image task ${status.toLowerCase()}`,
				);
			}
		}
	}
	if (!imageUrl)
		throw dependencyUnavailable(
			'Alibaba Bailian did not return a generated image before timeout',
		);
	try {
		const parsed = new URL(imageUrl);
		if (parsed.protocol !== 'https:') throw new Error('HTTPS is required');
	} catch {
		throw dependencyUnavailable(
			'Alibaba Bailian returned an invalid image URL',
		);
	}
	return {url: imageUrl, warnings: []};
};

const persistDashScopeImage = async (
	input: CleanPlateInpaintInput,
	imageUrl: string,
): Promise<ImageAsset> => {
	const response = await fetch(imageUrl);
	if (!response.ok)
		throw dependencyUnavailable(
			`Failed to download Alibaba Bailian image (${response.status})`,
		);
	const contentType =
		response.headers.get('content-type')?.split(';')[0].trim() || 'image/png';
	const body = Buffer.from(await response.arrayBuffer());
	const dimensions = readRasterDimensions(body, contentType);
	if (
		dimensions &&
		(dimensions.width !== input.canvas.width ||
			dimensions.height !== input.canvas.height)
	) {
		throw dependencyUnavailable(
			`Alibaba Bailian returned ${dimensions.width}x${dimensions.height}; expected ${input.canvas.width}x${input.canvas.height}. Set a supported DASHSCOPE_IMAGE_EDIT_MODEL or adjust the source canvas.`,
		);
	}
	const keyPart =
		`${input.projectId}/${input.shotId}/${input.clientRequestId || crypto.randomUUID()}`.replace(
			/[^a-zA-Z0-9/_-]+/g,
			'_',
		);
	const extension =
		contentType === 'image/jpeg'
			? 'jpg'
			: contentType === 'image/webp'
				? 'webp'
				: 'png';
	const key = `comic/inpaint/${keyPart}.${extension}`;
	try {
		await putCOSObject({key, body, contentType});
		return {
			id: `inpaint:${keyPart}`,
			type: 'image',
			filename: `${input.shotId}-clean-plate.${extension}`,
			size: body.length,
			remoteUrl: getCOSReadUrl(key),
			remoteFileKey: key,
			mimeType: contentType,
			width: input.canvas.width,
			height: input.canvas.height,
		};
	} catch (error) {
		if (error instanceof ComicEditorError) throw error;
		throw dependencyUnavailable(
			'Generated image could not be saved to COS. Configure COS_SECRET_ID, COS_SECRET_KEY, COS_REGION, COS_BUCKET, and COS_CDN_DOMAIN.',
		);
	}
};

const readRasterDimensions = (
	body: Buffer,
	contentType: string,
): {width: number; height: number} | null => {
	if (
		contentType === 'image/png' &&
		body.length >= 24 &&
		body.readUInt32BE(0) === 0x89504e47
	) {
		return {width: body.readUInt32BE(16), height: body.readUInt32BE(20)};
	}
	if (
		contentType === 'image/jpeg' &&
		body.length > 4 &&
		body[0] === 0xff &&
		body[1] === 0xd8
	) {
		let offset = 2;
		while (offset + 9 < body.length) {
			if (body[offset] !== 0xff) {
				offset += 1;
				continue;
			}
			const marker = body[offset + 1];
			const length = body.readUInt16BE(offset + 2);
			if (marker >= 0xc0 && marker <= 0xc3 && offset + 8 < body.length) {
				return {
					width: body.readUInt16BE(offset + 7),
					height: body.readUInt16BE(offset + 5),
				};
			}
			if (length < 2) break;
			offset += 2 + length;
		}
	}
	return null;
};

const readServiceUrl = (): URL => {
	const raw = process.env.COMIC_INPAINT_SERVICE_URL?.trim();
	if (!raw) {
		throw dependencyUnavailable('COMIC_INPAINT_SERVICE_URL is not configured');
	}

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw dependencyUnavailable('COMIC_INPAINT_SERVICE_URL is invalid');
	}

	if (url.protocol !== 'https:') {
		throw dependencyUnavailable('COMIC_INPAINT_SERVICE_URL must use HTTPS');
	}

	return url;
};

const endpoint = (path: string): string => {
	const base = readServiceUrl();
	const prefix = base.pathname.replace(/\/+$/, '');
	base.pathname = `${prefix}/${path.replace(/^\/+/, '')}`;
	base.search = '';
	base.hash = '';
	return base.href;
};

const headers = (): HeadersInit => {
	const next: Record<string, string> = {'content-type': 'application/json'};
	const token = process.env.COMIC_INPAINT_API_KEY?.trim();
	if (token) {
		next.authorization = `Bearer ${token}`;
	}

	return next;
};

const readJson = async (response: Response): Promise<unknown> => {
	try {
		return await response.json();
	} catch {
		throw dependencyUnavailable('Inpaint service returned invalid JSON');
	}
};

const assertOk = async (response: Response): Promise<unknown> => {
	const body = await readJson(response);
	if (!response.ok) {
		const message =
			body && typeof body === 'object' && 'message' in body
				? String((body as {message: unknown}).message)
				: `Inpaint service failed with ${response.status}`;
		throw dependencyUnavailable(message);
	}

	return body;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value !== null;
};

const readString = (value: unknown, label: string): string => {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw domainInvariant(`Inpaint response is missing ${label}`);
	}

	return value;
};

const readNumber = (value: unknown, label: string): number => {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw domainInvariant(`Inpaint response ${label} must be finite`);
	}

	return value;
};

const readRatio = (value: unknown, label: string): number => {
	const number = readNumber(value, label);
	if (number < 0 || number > 1) {
		throw domainInvariant(`Inpaint response ${label} must be between 0 and 1`);
	}
	return number;
};

const readImageAsset = (
	value: unknown,
	expected: {width: number; height: number},
): ImageAsset => {
	if (!isRecord(value)) {
		throw domainInvariant('Inpaint response cleanPlateAsset must be an object');
	}

	const width = readNumber(value.width, 'width');
	const height = readNumber(value.height, 'height');
	if (width !== expected.width || height !== expected.height) {
		throw domainInvariant(
			'Clean plate dimensions must match the source canvas',
		);
	}

	const remoteUrl = readString(value.remoteUrl, 'remoteUrl');
	let url: URL;
	try {
		url = new URL(remoteUrl);
	} catch {
		throw domainInvariant('Clean plate remoteUrl must be a valid URL');
	}

	if (url.protocol !== 'https:') {
		throw domainInvariant('Clean plate remoteUrl must use HTTPS');
	}

	return {
		id: readString(value.id, 'id'),
		type: 'image',
		filename: readString(value.filename, 'filename'),
		size: Math.max(0, Math.round(readNumber(value.size ?? 0, 'size'))),
		remoteUrl,
		remoteFileKey:
			typeof value.remoteFileKey === 'string' ? value.remoteFileKey : null,
		mimeType:
			typeof value.mimeType === 'string' && value.mimeType.trim()
				? value.mimeType
				: 'image/png',
		width,
		height,
	};
};

const readDiagnostics = (value: unknown): CleanPlateDiagnostics => {
	if (!isRecord(value)) {
		throw domainInvariant('Inpaint response diagnostics must be an object');
	}

	const warnings = Array.isArray(value.warnings)
		? value.warnings.map((entry) => String(entry))
		: [];
	return {
		alphaHoleRatio: readRatio(value.alphaHoleRatio, 'alphaHoleRatio'),
		edgeArtifactScore: readRatio(value.edgeArtifactScore, 'edgeArtifactScore'),
		recompositionScore: readRatio(
			value.recompositionScore,
			'recompositionScore',
		),
		warnings,
	};
};

export const requestCleanPlateInpaint = async (
	input: CleanPlateInpaintInput,
): Promise<CleanPlateInpaintResult> => {
	if (
		!Number.isInteger(input.canvas.width) ||
		!Number.isInteger(input.canvas.height) ||
		input.canvas.width <= 0 ||
		input.canvas.height <= 0
	) {
		throw domainInvariant('Clean plate canvas must have positive dimensions');
	}
	if (input.cloneSource) {
		if (
			!Number.isFinite(input.cloneSource.x) ||
			!Number.isFinite(input.cloneSource.y) ||
			input.cloneSource.x < 0 ||
			input.cloneSource.y < 0 ||
			input.cloneSource.x >= input.canvas.width ||
			input.cloneSource.y >= input.canvas.height
		) {
			throw domainInvariant('Clone source must be inside the source canvas');
		}
	}
	if (input.fillColor) {
		try {
			parseCleanPlateColor(input.fillColor);
		} catch (error) {
			throw domainInvariant(
				error instanceof Error ? error.message : 'Fill color is invalid',
			);
		}
	}

	// Keep the existing service contract as an override, while allowing a direct
	// Alibaba Bailian integration when only DASHSCOPE_API_KEY is configured.
	if (
		input.mode === 'ai-inpaint' &&
		!process.env.COMIC_INPAINT_SERVICE_URL?.trim()
	) {
		if (!hasDashScopeCredentials()) {
			throw dependencyUnavailable(
				'Configure DASHSCOPE_API_KEY (Alibaba Bailian) or COMIC_INPAINT_SERVICE_URL',
			);
		}
		const generated = await fetchDashScopeImage(input);
		const cleanPlateAsset = await persistDashScopeImage(input, generated.url);
		return {
			cleanPlateAsset,
			diagnostics: {
				alphaHoleRatio: 0,
				edgeArtifactScore: 0,
				recompositionScore: 0,
				warnings: [
					'Generated by Alibaba Bailian Wan2.1 ImageEdit; verify masked edges before export.',
					...generated.warnings,
				],
			},
		};
	}

	const response = await fetch(endpoint('/inpaint'), {
		method: 'POST',
		headers: headers(),
		body: JSON.stringify(input),
	});
	const body = await assertOk(response);
	if (!isRecord(body)) {
		throw domainInvariant('Inpaint response must be an object');
	}

	return {
		cleanPlateAsset: readImageAsset(body.cleanPlateAsset, input.canvas),
		diagnostics: readDiagnostics(body.diagnostics),
	};
};
