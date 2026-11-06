'use client';

import {
	AlertTriangle,
	CheckCircle2,
	Download,
	LoaderCircle,
	PackageCheck,
	RefreshCw,
} from 'lucide-react';
import {useTranslations} from 'next-intl';
import React, {useCallback, useMemo, useState} from 'react';
import {toast} from 'sonner';
import type {DeliveryFileEntry, OutputBatch} from '../comic/types';
import {postCompose} from '../compose/client';
import {useProjectContext} from '../project/project-context';
import {getCurrentSnapshot} from '../project/project-store';
import {
	attachSubmittedRenderJob,
	waitForRenderJobTerminal,
} from '../rendering/render-job-runtime';
import {renderJobStore} from '../rendering/render-job-store';
import {transitionRenderJob} from '../rendering/render-job-machine';
import {runRenderPreflight, type RenderPreflightResult} from '../rendering/render-preflight';
import {adoptUndoableState} from '../state/adopt-undoable-state';
import {getClientProjectId} from '../state/project-id';
import type {UndoableState} from '../state/types';
import {clsx} from '../utils/clsx';
import {useFullState, useWriteContext} from '../utils/use-context';

type PackageResponse = {
	type: 'success';
	deliveryStatus: 'delivery-complete' | 'delivery-incomplete';
	packageUrl: string;
	packageSizeBytes: number;
	packageChecksum: string;
	missingFiles: Array<{path: string; reason: string; url?: string}>;
	warnings: string[];
	manifest: {
		playOrder: string[];
		files: DeliveryFileEntry[];
	};
};

type VerifyResponse = {
	type: 'success';
	valid: boolean;
	deliveryStatus: 'delivery-complete' | 'delivery-incomplete';
	project: UndoableState;
	checkedFiles: number;
	missingFiles: string[];
	failures: string[];
	warnings: string[];
};

type BatchRenderSubmission =
	| {
			batchId: string;
			ok: true;
			renderId: string;
			bucketName: string;
	  }
	| {
			batchId: string;
			ok: false;
			error: {
				message: string;
			};
	  };

type BatchRenderResponse = {
	type: 'success';
	batches: OutputBatch[];
	results: BatchRenderSubmission[];
};

type MergeResponse = {
	type: 'success';
	file: DeliveryFileEntry;
	batchIds: string[];
};

const safePath = (value: string): string =>
	value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'asset';

const deliveryFilesFor = (project: UndoableState): DeliveryFileEntry[] =>
	Object.values(project.assets).map((asset, index) => {
		const path = `assets/${String(index + 1).padStart(4, '0')}-${safePath(
			asset.filename,
		)}`;
		const category = asset.type === 'audio' ? 'audio' : 'source';
		if (!asset.remoteUrl) {
			return {
				path,
				category,
				order: index,
				missingReason: 'Asset has no remote URL; upload it before delivery',
			};
		}

		return {
			path,
			category,
			order: index,
			url: asset.remoteUrl,
		};
	});

export const DeliveryPackageButton: React.FC = () => {
	const t = useTranslations('editor.actionRow.delivery');
	const state = useFullState();
	const {setState} = useWriteContext();
	const {activeProject, isReadOnly, saveNow} = useProjectContext();
	const [busy, setBusy] = useState(false);
	const [verifying, setVerifying] = useState(false);
	const [result, setResult] = useState<PackageResponse | null>(null);
	const [verification, setVerification] = useState<VerifyResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [preflight, setPreflight] = useState<RenderPreflightResult | null>(null);

	const fileCount = useMemo(
		() => Object.keys(state.undoableState.assets).length,
		[state.undoableState.assets],
	);

	const buildPackage = useCallback(async () => {
		setBusy(true);
		setError(null);
		setResult(null);
		setVerification(null);
		try {
			if (!activeProject || isReadOnly) {
				throw new Error('请先打开可编辑工程。');
			}
			if (!(await saveNow('manual'))) {
				throw new Error('工程尚未保存，无法创建可追溯交付任务。');
			}
			const inputSnapshot = await getCurrentSnapshot(activeProject.projectId);
			if (!inputSnapshot) throw new Error('找不到当前工程输入快照。');
			let gate = await runRenderPreflight({
				project: state.undoableState,
				snapshot: inputSnapshot,
				purpose: 'delivery',
			});
			setPreflight(gate);
			if (gate.status === 'blocked') {
				throw new Error(
					gate.issues.map((issue) => `${issue.code}: ${issue.message}`).join(' · '),
				);
			}
			let warningsConfirmed = false;
			if (gate.requiresConfirmation) {
				warningsConfirmed = window.confirm(
					`交付警告：\n${gate.issues
						.filter((issue) => issue.severity === 'warning')
						.map((issue) => `• ${issue.message}`)
						.join('\n')}\n\n仍然提交？`,
				);
				if (!warningsConfirmed) return;
				gate = await runRenderPreflight({
					project: state.undoableState,
					snapshot: inputSnapshot,
					purpose: 'delivery',
					warningsConfirmed: true,
				});
				setPreflight(gate);
			}
			const plan =
				(state.undoableState.shots ?? []).length === 0
					? {batches: []}
					: await postCompose<{batches: OutputBatch[]}>(
							'/api/compose/project/plan-batches',
							{
								project: state.undoableState,
								clientRequestId: `plan-${getClientProjectId()}`,
							},
						);
			let deliveryFiles = deliveryFilesFor(state.undoableState);

			if (plan.batches.length > 0) {
				toast.info(t('rendering'));
				const submitted = await postCompose<BatchRenderResponse>(
					'/api/compose/project/render-batches',
					{
						project: state.undoableState,
						inputSnapshotId: inputSnapshot.snapshotId,
						inputContentHash: inputSnapshot.contentHash,
						preflightHash: gate.preflightHash,
						warningsConfirmed,
						clientRequestId: `delivery-render-${getClientProjectId()}`,
					},
				);
				const failedSubmission = submitted.results.find(
					(
						batchResult,
					): batchResult is Extract<BatchRenderSubmission, {ok: false}> =>
						!batchResult.ok,
				);
				if (failedSubmission) {
					throw new Error(failedSubmission.error.message);
				}

				const attachedJobs = await Promise.all(
					submitted.results.map(async (batchResult) => {
						const success = batchResult as Extract<
							BatchRenderSubmission,
							{ok: true}
						>;
						return attachSubmittedRenderJob({
							input: {
								projectId: activeProject.projectId,
								projectName: activeProject.name,
								inputSnapshotId: inputSnapshot.snapshotId,
								inputContentHash: inputSnapshot.contentHash,
								preflightHash: gate.preflightHash,
								inputRevision: inputSnapshot.revision,
								kind: 'batch',
								batchId: success.batchId,
								frameRange: (() => {
									const batch = submitted.batches.find(
										(candidate) => candidate.batchId === success.batchId,
									);
									return batch
										? [batch.fromFrame, batch.endFrameInclusive]
										: undefined;
								})(),
								backend: success.bucketName === 'local' ? 'local' : 'lambda',
							},
							handle: success,
						});
					}),
				);
				const terminalJobs = await Promise.all(
					attachedJobs.map((job) => waitForRenderJobTerminal(job.jobId)),
				);
				const failedJob = terminalJobs.find(
					(job) => !job || job.status !== 'succeeded',
				);
				if (failedJob) {
					throw new Error(failedJob?.lastError?.message ?? '批次渲染未完成。');
				}
				const renderedBatches = terminalJobs.map((job, index) => {
					if (!job || job.status !== 'succeeded' || !job.outputFile) {
						throw new Error(
							`Batch ${submitted.batches[index]?.batchId ?? index} render failed`,
						);
					}
					return {
						batchId:
							job.batchId ?? submitted.batches[index]?.batchId ?? String(index),
						status: 'done' as const,
						outputFile: job.outputFile,
						outputSizeInBytes: job.outputSizeInBytes,
						checksum: job.checksum,
					};
				});
				toast.info(t('merging'));
				const merged = await postCompose<MergeResponse>(
					'/api/compose/project/merge-batches',
					{
						projectId: getClientProjectId(),
						project: state.undoableState,
						batches: submitted.batches,
						renderedBatches,
						clientRequestId: `delivery-merge-${getClientProjectId()}`,
					},
				);
				const mergeJob = await renderJobStore.create({
					projectId: activeProject.projectId,
					projectName: activeProject.name,
					inputSnapshotId: inputSnapshot.snapshotId,
					inputContentHash: inputSnapshot.contentHash,
					preflightHash: gate.preflightHash,
					inputRevision: inputSnapshot.revision,
					kind: 'merge',
					backend: gate.capabilities.renderBackend,
				});
				await renderJobStore.put(
					transitionRenderJob(
						transitionRenderJob(mergeJob, {type: 'validate'}),
						{
							type: 'submit',
							handle: {renderId: `merge-${mergeJob.jobId}`, bucketName: 'local'},
							backend: 'local',
						},
					),
				);
				await renderJobStore.update(mergeJob.jobId, (job) =>
					transitionRenderJob(job, {
						type: 'succeed',
						output: {
							outputFile: merged.file.url!,
							outputName: 'full.mp4',
							outputSizeInBytes: merged.file.sizeBytes ?? 0,
							checksum: merged.file.checksum,
						},
					}),
				);
				const batchFiles = renderedBatches.map((rendered) => ({
					path: `final-video/${rendered.batchId}.mp4`,
					category: 'final-video' as const,
					order:
						submitted.batches.find(
							(batch) => batch.batchId === rendered.batchId,
						)?.batchIndex ?? 0,
					url: rendered.outputFile,
					...(rendered.outputSizeInBytes !== undefined
						? {sizeBytes: rendered.outputSizeInBytes}
						: {}),
					...(rendered.checksum ? {checksum: rendered.checksum} : {}),
				}));
				deliveryFiles = [...deliveryFiles, ...batchFiles, merged.file];
			}

			const packaged = await postCompose<PackageResponse>(
				'/api/compose/project/export-package',
				{
					projectId: getClientProjectId(),
					project: state.undoableState,
					batches: plan.batches,
					files: deliveryFiles,
					inputSnapshotId: inputSnapshot.snapshotId,
					inputRevision: inputSnapshot.revision,
					inputContentHash: inputSnapshot.contentHash,
					preflightHash: gate.preflightHash,
					warningsConfirmed,
					clientRequestId: `delivery-${getClientProjectId()}`,
				},
			);
			setResult(packaged);
			const deliveryJob = await renderJobStore.create({
				projectId: activeProject.projectId,
				projectName: activeProject.name,
				inputSnapshotId: inputSnapshot.snapshotId,
				inputContentHash: inputSnapshot.contentHash,
				preflightHash: gate.preflightHash,
				inputRevision: inputSnapshot.revision,
				kind: 'delivery',
				backend: gate.capabilities.renderBackend,
			});
			let storedDeliveryJob = transitionRenderJob(deliveryJob, {type: 'validate'});
			storedDeliveryJob = transitionRenderJob(storedDeliveryJob, {
				type: 'submit',
				handle: {renderId: `delivery-${deliveryJob.jobId}`, bucketName: 'local'},
				backend: 'local',
			});
			storedDeliveryJob =
				packaged.deliveryStatus === 'delivery-complete'
					? transitionRenderJob(storedDeliveryJob, {
						type: 'succeed',
						output: {
							outputFile: packaged.packageUrl,
							outputName: 'delivery.zip',
							outputSizeInBytes: packaged.packageSizeBytes,
							checksum: packaged.packageChecksum,
						},
					})
					: transitionRenderJob(storedDeliveryJob, {
						type: 'fail',
						error: {
							code: 'DELIVERY_INCOMPLETE',
							message: 'The diagnostic ZIP is incomplete and is not final delivery.',
							retryable: false,
						},
					});
			await renderJobStore.put(storedDeliveryJob);
			if (packaged.deliveryStatus === 'delivery-complete') {
				toast.success(t('generated'));
			} else {
				toast.warning(t('incomplete'));
			}
			if (plan.batches.length === 0) {
				toast.info(t('noBatchesWarning'));
			}
		} catch (buildError) {
			const message =
				buildError instanceof Error ? buildError.message : t('failed');
			setError(message);
			toast.error(t('failed'), {description: message});
		} finally {
			setBusy(false);
		}
	}, [activeProject, isReadOnly, saveNow, state.undoableState, t]);

	const verifyPackage = useCallback(async () => {
		if (!result?.packageUrl) return;
		setVerifying(true);
		setError(null);
		try {
			const checked = await postCompose<VerifyResponse>(
				'/api/compose/project/verify-package',
				{packageUrl: result.packageUrl},
			);
			setVerification(checked);
			if (!checked.valid || checked.deliveryStatus !== 'delivery-complete') {
				toast.error(t('verifyFailed'));
			} else {
				toast.success(t('verified'));
			}
		} catch (verifyError) {
			const message =
				verifyError instanceof Error ? verifyError.message : t('verifyFailed');
			setError(message);
			toast.error(t('verifyFailed'), {description: message});
		} finally {
			setVerifying(false);
		}
	}, [result?.packageUrl, t]);

	const loadVerifiedProject = useCallback(() => {
		if (
			!verification?.project ||
			!verification.valid ||
			verification.deliveryStatus !== 'delivery-complete'
		)
			return;
		setState({
			update: (current) => adoptUndoableState(current, verification.project),
			commitToUndoStack: true,
		});
		toast.success(t('reloaded'));
	}, [setState, t, verification]);

	return (
		<div className="border-editor-starter-surface-separator bg-editor-starter-inset rounded-xl border p-3">
			<div className="flex items-center gap-2 text-[13px] font-semibold">
				<PackageCheck className="size-4" />
				<span>{t('title')}</span>
			</div>
			<div className="text-editor-starter-text-muted mt-1 text-[11px]">
				{t('assetSummary', {count: fileCount})}
			</div>
			{preflight ? (
				<div className="mt-2 text-[10px] text-white/55">
					{preflight.capabilities.renderBackend} · ffmpeg {preflight.capabilities.ffmpeg.available ? 'ok' : 'missing'} · COS {preflight.capabilities.cos.configured ? 'ok' : 'missing'} · fonts {preflight.capabilities.fonts.available ? 'ok' : 'missing'}
				</div>
			) : null}
			<button
				type="button"
				className="bg-editor-starter-accent text-editor-starter-on-accent hover:bg-editor-starter-accent/90 mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-xl px-3 text-xs font-semibold disabled:opacity-40"
				disabled={busy}
				onClick={buildPackage}
			>
				{busy ? (
					<LoaderCircle className="size-4 animate-spin" />
				) : (
					<PackageCheck className="size-4" />
				)}
				{busy ? t('generating') : t('generate')}
			</button>

			{error ? (
				<div className="mt-2 flex gap-2 text-[11px] leading-5 text-red-200">
					<AlertTriangle className="mt-0.5 size-4 shrink-0" />
					<span>{error}</span>
				</div>
			) : null}

			{result ? (
				<div className="mt-3 space-y-2 border-t border-white/8 pt-3 text-[11px]">
					<div className={result.deliveryStatus === 'delivery-complete' ? 'text-emerald-300' : 'text-amber-300'}>
						{result.deliveryStatus === 'delivery-complete' ? t('complete') : t('incomplete')}
					</div>
					<div className="flex items-center justify-between gap-2">
						<span className="text-editor-starter-text-muted">
							{t('packageSize', {
								size: Math.max(1, Math.round(result.packageSizeBytes / 1024)),
							})}
						</span>
						<a
							className="text-editor-starter-accent flex items-center gap-1 hover:underline"
							href={result.packageUrl}
							target="_blank"
							rel="noreferrer"
						>
							<Download className="size-3.5" />
							{t('download')}
						</a>
					</div>
					<button
						type="button"
						className="flex h-8 w-full items-center justify-center gap-2 rounded border border-white/10 text-white/75 hover:bg-white/8 disabled:opacity-40"
						disabled={verifying}
						onClick={verifyPackage}
					>
						{verifying ? (
							<LoaderCircle className="size-3.5 animate-spin" />
						) : (
							<RefreshCw className="size-3.5" />
						)}
						{verifying ? t('verifying') : t('verify')}
					</button>
					{result.missingFiles.length > 0 ? (
						<div className="text-amber-100/75">
							{t('missingSummary', {count: result.missingFiles.length})}
						</div>
					) : null}
					{result.warnings.length > 0 ? (
						<div className="text-amber-100/75">{result.warnings.join(' ')}</div>
					) : null}
				</div>
			) : null}

			{verification ? (
				<div
					className={clsx(
						'mt-3 space-y-2 border-t border-white/8 pt-3 text-[11px]',
						verification.valid &&
							verification.deliveryStatus === 'delivery-complete'
							? 'text-emerald-100/80'
							: 'text-red-100/80',
					)}
				>
					<div className="flex items-center gap-2 font-semibold">
						{verification.valid &&
						verification.deliveryStatus === 'delivery-complete' ? (
							<CheckCircle2 className="size-4" />
						) : (
							<AlertTriangle className="size-4" />
						)}
						<span>
									{verification.valid &&
									verification.deliveryStatus === 'delivery-complete'
										? t('verified')
										: t('verifyFailed')}
						</span>
					</div>
					<div>{t('checkedSummary', {count: verification.checkedFiles})}</div>
					{verification.failures.length > 0 ? (
						<div>{verification.failures.join(' ')}</div>
					) : null}
					{verification.missingFiles.length > 0 ? (
						<div>
							{t('missingSummary', {
								count: verification.missingFiles.length,
							})}
						</div>
					) : null}
					{verification.valid &&
					verification.deliveryStatus === 'delivery-complete' ? (
						<button
							type="button"
							className="flex h-8 w-full items-center justify-center rounded border border-emerald-200/20 bg-emerald-200/8 text-emerald-100 hover:bg-emerald-200/12"
							onClick={loadVerifiedProject}
						>
							{t('reload')}
						</button>
					) : null}
				</div>
			) : null}
		</div>
	);
};
