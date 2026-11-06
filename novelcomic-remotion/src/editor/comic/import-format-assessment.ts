export const IMPORT_FORMAT_KINDS = [
	'psd',
	'lottie',
	'image-sequence',
	'transparent-video',
	'unknown',
] as const;

export type ImportFormatKind = (typeof IMPORT_FORMAT_KINDS)[number];

export type ImportSupportLevel =
	| 'direct'
	| 'convert-first'
	| 'external-render'
	| 'unsupported';

export type ImportFormatAssessmentInput = {
	filename?: string;
	mimeType?: string;
	hasAlpha?: boolean;
	sidecarFilenames?: string[];
};

export type ImportFormatAssessment = {
	format: ImportFormatKind;
	support: ImportSupportLevel;
	canProduceLayerPackage: boolean;
	canPreserveTiming: boolean;
	recommendedPath: string;
	requiredOutputs: string[];
	warnings: string[];
};

const extensionOf = (filename: string | undefined): string => {
	if (!filename) {
		return '';
	}

	const lower = filename.toLowerCase();
	const parts = lower.split('.');
	return parts.length > 1 ? (parts.pop() ?? '') : '';
};

const hasSidecar = (
	input: ImportFormatAssessmentInput,
	pattern: RegExp,
): boolean => {
	return (input.sidecarFilenames ?? []).some((filename) => {
		return pattern.test(filename.toLowerCase());
	});
};

export const detectImportFormat = (
	input: ImportFormatAssessmentInput,
): ImportFormatKind => {
	const extension = extensionOf(input.filename);
	const mimeType = input.mimeType?.toLowerCase() ?? '';

	if (extension === 'psd' || mimeType === 'image/vnd.adobe.photoshop') {
		return 'psd';
	}

	if (
		extension === 'lottie' ||
		input.filename?.toLowerCase().endsWith('.lottie.json')
	) {
		return 'lottie';
	}

	if (
		['png', 'webp', 'jpg', 'jpeg'].includes(extension) &&
		hasSidecar(input, /(?:^|[-_.])\d{3,6}\.(png|webp|jpg|jpeg)$/)
	) {
		return 'image-sequence';
	}

	if (['webm', 'mov', 'mp4'].includes(extension)) {
		return 'transparent-video';
	}

	return 'unknown';
};

export const assessImportFormat = (
	input: ImportFormatAssessmentInput,
): ImportFormatAssessment => {
	const format = detectImportFormat(input);

	if (format === 'psd') {
		return {
			format,
			support: 'convert-first',
			canProduceLayerPackage: true,
			canPreserveTiming: false,
			recommendedPath:
				'Convert PSD layers into transparent PNG/WebP files plus a LayerPackage, then import through /api/compose/layers/import.',
			requiredOutputs: [
				'LayerPackage JSON',
				'transparent layer images',
				'source or clean-plate image',
			],
			warnings: [
				'Layer styles, adjustment layers, masks, and blend modes should be baked or downgraded before import.',
				'PSD is not a runtime project format for this editor.',
			],
		};
	}

	if (format === 'lottie') {
		return {
			format,
			support: 'convert-first',
			canProduceLayerPackage: false,
			canPreserveTiming: true,
			recommendedPath:
				'Convert Lottie to a rendered transparent video/sequence first, or add a dedicated Lottie item type later.',
			requiredOutputs: ['transparent video or PNG sequence', 'timing manifest'],
			warnings: [
				'A dedicated Lottie renderer item is not currently implemented.',
			],
		};
	}

	if (format === 'image-sequence') {
		return {
			format,
			support: 'direct',
			canProduceLayerPackage: false,
			canPreserveTiming: true,
			recommendedPath:
				'Import as an image sequence or rendered asset, then place it on the timeline.',
			requiredOutputs: ['ordered image files', 'fps or timing manifest'],
			warnings: [],
		};
	}

	if (format === 'transparent-video') {
		return {
			format,
			support: input.hasAlpha ? 'direct' : 'convert-first',
			canProduceLayerPackage: false,
			canPreserveTiming: true,
			recommendedPath: input.hasAlpha
				? 'Import the transparent video as a normal video layer.'
				: 'Render or transcode with alpha before using it as an overlay animation.',
			requiredOutputs: ['video file', 'duration metadata'],
			warnings: input.hasAlpha
				? []
				: ['No alpha channel was declared; this may not work as an overlay.'],
		};
	}

	return {
		format,
		support: 'unsupported',
		canProduceLayerPackage: false,
		canPreserveTiming: false,
		recommendedPath:
			'Convert the asset into LayerPackage, transparent video, or image sequence before importing.',
		requiredOutputs: [
			'LayerPackage JSON or rendered transparent media',
			'duration metadata',
		],
		warnings: ['Unknown source format.'],
	};
};
