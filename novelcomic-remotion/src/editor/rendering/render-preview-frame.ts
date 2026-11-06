import {
	renderStillOnLambda,
	speculateFunctionName,
} from '@remotion/lambda/client';
import {
	COMP_NAME,
	DISK_SIZE_IN_MB,
	MEM_SIZE_IN_MB,
	SITE_NAME,
	TIMEOUT_IN_SECONDS,
} from '../../remotion/constants';
import {
	COMIC_ERROR_CODES,
	ComicEditorError,
	domainInvariant,
} from '../comic/errors';
import type {UndoableState} from '../state/types';
import {getCompositionDuration} from '../utils/get-composition-duration';
import {requireServerEnv} from '../utils/server-env';
import {
	toCompositionProps,
	type ComicCompositionProps,
} from './to-composition-props';
import {validateRenderMotion} from './validate-render-payload';

export type PreviewFrameRequest = {
	project: UndoableState;
	frame: number;
	width?: number;
	format?: 'png' | 'jpeg';
	submit?: PreviewFrameSubmitter;
};

export type PreviewFrameResult = {
	url?: string;
	taskId?: string;
};

export type PreviewFrameJob = {
	props: ComicCompositionProps;
	frame: number;
	width?: number;
	format: 'png' | 'jpeg';
};

export type PreviewFrameSubmitter = (
	job: PreviewFrameJob,
) => Promise<PreviewFrameResult>;

const projectDuration = (project: UndoableState): number => {
	const itemDuration = getCompositionDuration(Object.values(project.items));
	const shotDuration = (project.shots ?? []).reduce((max, shot) => {
		return Math.max(max, shot.from + shot.durationInFrames);
	}, 0);
	return Math.max(itemDuration, shotDuration);
};

const redactUrlQuery = (message: string): string => {
	return message.replace(/https?:\/\/\S+/g, (raw) => {
		const url = raw.replace(/[),.;]+$/, '');
		try {
			const parsed = new URL(url);
			return `${parsed.origin}${parsed.pathname}`;
		} catch {
			return '[url]';
		}
	});
};

export const submitPreviewFrameOnLambda: PreviewFrameSubmitter = async (
	job,
) => {
	const serverEnv = requireServerEnv();
	const scaledHeight =
		job.width === undefined
			? undefined
			: Math.max(
					1,
					Math.round(
						job.props.compositionHeight *
							(job.width / job.props.compositionWidth),
					),
				);
	const still = await renderStillOnLambda({
		region: serverEnv.REMOTION_AWS_REGION,
		functionName: speculateFunctionName({
			diskSizeInMb: DISK_SIZE_IN_MB,
			memorySizeInMb: MEM_SIZE_IN_MB,
			timeoutInSeconds: TIMEOUT_IN_SECONDS,
		}),
		serveUrl: SITE_NAME,
		composition: COMP_NAME,
		inputProps: job.props as unknown as Record<string, unknown>,
		imageFormat: job.format,
		privacy: 'public',
		frame: job.frame,
		...(job.width !== undefined && scaledHeight !== undefined
			? {forceWidth: job.width, forceHeight: scaledHeight}
			: {}),
	});
	return {
		url: still.url,
		taskId: still.renderId,
	};
};

export const renderPreviewFrame = async (
	input: PreviewFrameRequest,
): Promise<PreviewFrameResult> => {
	if (!Number.isInteger(input.frame) || input.frame < 0) {
		throw domainInvariant('Preview frame must be a non-negative integer');
	}

	if (
		input.width !== undefined &&
		(!Number.isInteger(input.width) || input.width < 1)
	) {
		throw domainInvariant('Preview width must be a positive integer');
	}

	const duration = projectDuration(input.project);
	if (input.frame >= duration) {
		throw domainInvariant(
			`Preview frame ${input.frame} is outside the project duration of ${duration}`,
		);
	}

	const props = toCompositionProps(input.project);
	try {
		validateRenderMotion(props.items, props.assets);
	} catch (error) {
		throw domainInvariant(
			error instanceof Error ? error.message : 'Invalid motion data',
		);
	}
	let result: PreviewFrameResult;
	try {
		result = await (input.submit ?? submitPreviewFrameOnLambda)({
			props,
			frame: input.frame,
			width: input.width,
			format: input.format ?? 'png',
		});
	} catch (error) {
		if (error instanceof ComicEditorError) {
			throw error;
		}

		throw new ComicEditorError({
			code: COMIC_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
			message: redactUrlQuery(
				error instanceof Error
					? error.message
					: 'Still render submission failed',
			),
			retryable: true,
			status: 503,
		});
	}

	if (!result.url && !result.taskId) {
		throw new ComicEditorError({
			code: COMIC_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
			message: 'Still render did not return a url or task id',
			retryable: true,
			status: 503,
		});
	}

	const preview: PreviewFrameResult = {};
	if (result.url) {
		preview.url = result.url;
	}
	if (result.taskId) {
		preview.taskId = result.taskId;
	}
	return preview;
};
