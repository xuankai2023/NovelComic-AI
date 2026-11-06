import type {ProjectIssue} from '../comic/types';
import {hashContent, projectContentHash} from '../project/project-hash';
import type {ProjectSnapshot} from '../project/types';
import type {UndoableState} from '../state/types';

export type ComposeCapabilities = {
	renderBackend: 'local' | 'lambda';
	local: {available: boolean; reason?: string};
	lambda: {configured: boolean; reason?: string};
	ffmpeg: {available: boolean; reason?: string};
	cos: {configured: boolean; reason?: string};
	fonts: {available: boolean; missing?: string[]};
	exportPackage: {available: boolean; reason?: string};
};

export type RenderPreflightPurpose = 'full-video' | 'batch' | 'delivery';
export type RenderPreflightIssue = {
	severity: 'error' | 'warning';
	code: string;
	message: string;
	objectId?: string;
	suggestion: string;
	source: 'project' | 'capability' | 'snapshot';
};

export type RenderPreflightResult = {
	status: 'blocked' | 'confirmation-required' | 'ready';
	canSubmit: boolean;
	requiresConfirmation: boolean;
	preflightHash: string;
	inputSnapshotId: string;
	inputContentHash: string;
	issues: RenderPreflightIssue[];
	capabilities: ComposeCapabilities;
};

type ValidationResponse = {
	valid: boolean;
	issues: ProjectIssue[];
};

const objectIdFor = (issue: ProjectIssue): string | undefined =>
	issue.shotId ?? issue.itemId ?? issue.assetId ?? issue.trackId;

const projectIssue = (issue: ProjectIssue): RenderPreflightIssue => ({
	severity: issue.severity,
	code: issue.code,
	message: issue.message,
	objectId: objectIdFor(issue),
	suggestion:
		issue.suggestion ??
		(issue.severity === 'error'
			? 'Fix this project issue before submitting.'
			: 'Review this warning and explicitly confirm before submitting.'),
	source: 'project',
});

const usedFonts = (project: UndoableState): string[] =>
	[
		...new Set(
			Object.values(project.items).flatMap((item) =>
				(item.type === 'text' || item.type === 'captions') && item.fontFamily
					? [item.fontFamily]
					: [],
			),
		),
	].sort();

const capabilityIssues = (
	capabilities: ComposeCapabilities,
	purpose: RenderPreflightPurpose,
): RenderPreflightIssue[] => {
	const issues: RenderPreflightIssue[] = [];
	const add = (
		code: string,
		message: string,
		suggestion: string,
	) =>
		issues.push({
			severity: 'error',
			code,
			message,
			suggestion,
			source: 'capability',
		});

	if (capabilities.renderBackend === 'local' && !capabilities.local.available) {
		add(
			'LOCAL_RENDERER_UNAVAILABLE',
			capabilities.local.reason ?? 'The local renderer is unavailable.',
			'Restore the Remotion renderer runtime or switch to Lambda.',
		);
	}
	if (
		capabilities.renderBackend === 'lambda' &&
		!capabilities.lambda.configured
	) {
		add(
			'LAMBDA_NOT_CONFIGURED',
			capabilities.lambda.reason ?? 'Remotion Lambda is not configured.',
			'Configure the Lambda region, bucket, site, and function settings.',
		);
	}
	if (!capabilities.fonts.available) {
		add(
			'MISSING_FONTS',
			`Project fonts are unavailable: ${(capabilities.fonts.missing ?? []).join(', ')}`,
			'Replace the missing fonts or add them to the font endpoint.',
		);
	}
	if (
		capabilities.renderBackend === 'local' &&
		!capabilities.cos.configured
	) {
		add(
			'COS_NOT_CONFIGURED',
			capabilities.cos.reason ?? 'COS upload and read URL are not configured.',
			'Configure COS upload credentials and a stable read URL.',
		);
	}
	if (purpose === 'delivery') {
		if (!capabilities.ffmpeg.available) {
			add(
				'FFMPEG_UNAVAILABLE',
				capabilities.ffmpeg.reason ?? 'ffmpeg is unavailable.',
				'Install ffmpeg or set FFMPEG_PATH to a working executable.',
			);
		}
		if (!capabilities.cos.configured) {
			add(
				'COS_NOT_CONFIGURED',
				capabilities.cos.reason ?? 'COS is not configured.',
				'Configure COS before building a stable delivery package.',
			);
		}
		if (!capabilities.exportPackage.available) {
			add(
				'EXPORT_PACKAGE_UNAVAILABLE',
				capabilities.exportPackage.reason ??
					'Package export dependencies are unavailable.',
				'Restore the package upload and read URL dependencies.',
			);
		}
	}

	return issues.filter(
		(issue, index, all) =>
			all.findIndex((candidate) => candidate.code === issue.code) === index,
	);
};

const readJson = async <T>(response: Response): Promise<T> => {
	const value = (await response.json()) as T | {message?: string};
	if (!response.ok) {
		throw new Error(
			(typeof value === 'object' && value && 'message' in value
				? value.message
				: undefined) ?? `Preflight request failed with HTTP ${response.status}.`,
		);
	}
	return value as T;
};

export const runRenderPreflight = async ({
	project,
	snapshot,
	purpose,
	warningsConfirmed = false,
	fetchImpl = fetch,
}: {
	project: UndoableState;
	snapshot: ProjectSnapshot;
	purpose: RenderPreflightPurpose;
	warningsConfirmed?: boolean;
	fetchImpl?: typeof fetch;
}): Promise<RenderPreflightResult> => {
	const fonts = usedFonts(project);
	const [validation, capabilities] = await Promise.all([
		readJson<ValidationResponse>(
			await fetchImpl('/api/compose/project/validate', {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify({project}),
			}),
		),
		readJson<ComposeCapabilities>(
			await fetchImpl(
				`/api/compose/capabilities?fonts=${encodeURIComponent(fonts.join(','))}`,
				{cache: 'no-store'},
			),
		),
	]);

	const issues = validation.issues.map(projectIssue);
	const actualHash = projectContentHash(project);
	if (snapshot.contentHash !== actualHash) {
		issues.push({
			severity: 'error',
			code: 'INPUT_SNAPSHOT_MISMATCH',
			message: 'The saved input snapshot does not match the project being submitted.',
			objectId: snapshot.snapshotId,
			suggestion: 'Save the project again and rerun preflight.',
			source: 'snapshot',
		});
	}
	issues.push(...capabilityIssues(capabilities, purpose));

	const hasErrors = issues.some((issue) => issue.severity === 'error');
	const hasWarnings = issues.some((issue) => issue.severity === 'warning');
	const status = hasErrors
		? 'blocked'
		: hasWarnings && !warningsConfirmed
			? 'confirmation-required'
			: 'ready';
	const preflightHash = hashContent({
		purpose,
		inputSnapshotId: snapshot.snapshotId,
		inputContentHash: snapshot.contentHash,
		issues,
		capabilities,
	});

	return {
		status,
		canSubmit: status === 'ready',
		requiresConfirmation: status === 'confirmation-required',
		preflightHash,
		inputSnapshotId: snapshot.snapshotId,
		inputContentHash: snapshot.contentHash,
		issues,
		capabilities,
	};
};
