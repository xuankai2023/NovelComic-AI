'use client';

import {
	AlertTriangle,
	CheckCircle2,
	LoaderCircle,
	Sparkles,
	X,
} from 'lucide-react';
import {useTranslations} from 'next-intl';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {toast} from 'sonner';
import type {ImageAsset} from '../assets/assets';
import type {CleanPlateInpaintMode} from '../comic/clean-plate';
import type {LayerSegmentationStatus} from '../comic/layer-segmentation';
import type {LayerPackage} from '../comic/types';
import {postCompose} from '../compose/client';
import {applyCleanPlateToState} from '../state/actions/apply-clean-plate';
import {adoptUndoableState} from '../state/adopt-undoable-state';
import {getClientProjectId} from '../state/project-id';
import {
	useAssets,
	useCurrentStateAsRef,
	useFullState,
	useShots,
	useWriteContext,
} from '../utils/use-context';

type SegmentationTaskResponse = {
	task: {
		jobId: string;
		status: 'queued' | 'running';
		progress?: number;
	};
};

type SegmentationStatusResponse = {
	status: LayerSegmentationStatus;
};

type ImportLayerResponse = {
	project: Parameters<typeof adoptUndoableState>[1];
	layerPackage?: LayerPackage;
};

type InpaintResponse = {
	cleanPlateAsset: ImageAsset;
	diagnostics: {
		warnings: string[];
		alphaHoleRatio: number;
		edgeArtifactScore: number;
		recompositionScore: number;
	};
};

const wait = (milliseconds: number) =>
	new Promise<void>((resolve) => {
		window.setTimeout(resolve, milliseconds);
	});

const imageAsset = (
	asset: ReturnType<typeof useAssets>['assets'][string] | undefined,
): asset is ImageAsset => asset?.type === 'image';

export const AiPipelinePanel: React.FC<{onClose: () => void}> = ({onClose}) => {
	const t = useTranslations('editor.actionRow.aiPipeline');
	const {assets} = useAssets();
	const {shots} = useShots();
	const state = useFullState();
	const stateRef = useCurrentStateAsRef();
	const {setState} = useWriteContext();
	const abortRef = useRef<AbortController | null>(null);
	const [sourceAssetId, setSourceAssetId] = useState('');
	const [shotId, setShotId] = useState('');
	const [semanticHints, setSemanticHints] = useState('');
	const [segmentationState, setSegmentationState] = useState<
		| {status: 'idle'}
		| {status: 'running'; jobId: string; progress?: number}
		| {status: 'done'; warnings: string[]}
		| {status: 'failed'; message: string}
	>({status: 'idle'});
	const [selectedLayerId, setSelectedLayerId] = useState('');
	const [inpaintMode, setInpaintMode] =
		useState<CleanPlateInpaintMode>('ai-inpaint');
	const [fillColor, setFillColor] = useState('#ffffff');
	const [inpainting, setInpainting] = useState(false);
	const [inpaintWarnings, setInpaintWarnings] = useState<string[]>([]);

	const uploadedImageAssets = useMemo(
		() =>
			Object.values(assets).filter(
				(asset): asset is ImageAsset =>
					asset.type === 'image' && Boolean(asset.remoteUrl),
			),
		[assets],
	);

	const manualLayers = useMemo(
		() => Object.values(state.undoableState.comicEditLayers ?? {}),
		[state.undoableState.comicEditLayers],
	);

	useEffect(() => {
		if (!sourceAssetId && uploadedImageAssets[0]) {
			setSourceAssetId(uploadedImageAssets[0].id);
		}
	}, [sourceAssetId, uploadedImageAssets]);

	useEffect(() => {
		if (!shotId && shots[0]) {
			setShotId(shots[0].id);
		}
	}, [shotId, shots]);

	useEffect(() => {
		if (!selectedLayerId && manualLayers[0]) {
			setSelectedLayerId(manualLayers[0].id);
		}
	}, [manualLayers, selectedLayerId]);

	const cancel = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setSegmentationState({status: 'idle'});
		setInpainting(false);
	}, []);

	const importLayerPackage = useCallback(
		async (layerPackage: LayerPackage, signal: AbortSignal) => {
			const response = await postCompose<ImportLayerResponse>(
				'/api/compose/layers/import',
				{
					project: stateRef.current.undoableState,
					layerPackage,
					clientRequestId: `segmentation-${layerPackage.projectId}-${layerPackage.shotId}`,
				},
				signal,
			);
			setState({
				update: (current) => adoptUndoableState(current, response.project),
				commitToUndoStack: true,
				command: {
					type: 'layer-package.import',
					transactionId: `layer-package:${layerPackage.projectId}:${layerPackage.shotId}`,
				},
			});
			return layerPackage.diagnostics.warnings;
		},
		[setState, stateRef],
	);

	const runSegmentation = useCallback(async () => {
		const asset = assets[sourceAssetId];
		if (!imageAsset(asset) || !asset.remoteUrl || !shotId) {
			setSegmentationState({
				status: 'failed',
				message: t('segmentationInputMissing'),
			});
			return;
		}

		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		setSegmentationState({status: 'running', jobId: '', progress: 0});
		try {
			const requested = await postCompose<SegmentationTaskResponse>(
				'/api/compose/layers/request-segmentation',
				{
					projectId: getClientProjectId(),
					shotId,
					sourceUrl: asset.remoteUrl,
					canvas: {
						width: asset.width,
						height: asset.height,
					},
					semanticHints: semanticHints
						.split(',')
						.map((hint) => hint.trim())
						.filter(Boolean),
				},
				controller.signal,
			);
			let status: LayerSegmentationStatus = requested.task;
			setSegmentationState({
				status: 'running',
				jobId: requested.task.jobId,
				progress: requested.task.progress,
			});

			for (let attempt = 0; attempt < 120; attempt += 1) {
				if (status.status === 'done') {
					const warnings = await importLayerPackage(
						status.layerPackage,
						controller.signal,
					);
					setSegmentationState({status: 'done', warnings});
					toast.success(t('segmentationImported'));
					return;
				}
				if (status.status === 'failed') {
					throw new Error(status.error);
				}

				await wait(1200);
				const statusResponse: SegmentationStatusResponse =
					await postCompose<SegmentationStatusResponse>(
						'/api/compose/layers/segmentation-status',
						{jobId: status.jobId},
						controller.signal,
					);
				status = statusResponse.status;
				setSegmentationState({
					status: 'running',
					jobId: status.jobId,
					progress: 'progress' in status ? status.progress : undefined,
				});
			}

			throw new Error(t('segmentationTimedOut'));
		} catch (error) {
			if (controller.signal.aborted) return;
			const message = error instanceof Error ? error.message : t('failed');
			setSegmentationState({status: 'failed', message});
			toast.error(t('segmentationFailed'), {description: message});
		} finally {
			if (abortRef.current === controller) {
				abortRef.current = null;
			}
		}
	}, [assets, importLayerPackage, semanticHints, shotId, sourceAssetId, t]);

	const runInpaint = useCallback(async () => {
		const layer =
			stateRef.current.undoableState.comicEditLayers?.[selectedLayerId];
		const source = layer ? assets[layer.sourceAssetId] : undefined;
		const mask = layer?.maskAssetId ? assets[layer.maskAssetId] : undefined;
		const effectiveShotId = layer?.shotId ?? shotId;
		if (
			!layer ||
			!imageAsset(source) ||
			!imageAsset(mask) ||
			!source.remoteUrl ||
			!mask.remoteUrl ||
			!effectiveShotId
		) {
			toast.error(t('inpaintFailed'), {
				description: t('inpaintInputMissing'),
			});
			return;
		}

		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		setInpainting(true);
		setInpaintWarnings([]);
		try {
			const response = await postCompose<InpaintResponse>(
				'/api/compose/layers/inpaint',
				{
					projectId: getClientProjectId(),
					shotId: effectiveShotId,
					sourceAssetId: source.id,
					maskAssetId: mask.id,
					sourceUrl: source.remoteUrl,
					maskUrl: mask.remoteUrl,
					canvas: {width: source.width, height: source.height},
					mode: inpaintMode,
					version: 1,
					fillColor: inpaintMode === 'solid-fill' ? fillColor : undefined,
				},
				controller.signal,
			);
			setState({
				update: (current) => {
					const next = applyCleanPlateToState({
						state: current,
						layerId: selectedLayerId,
						cleanPlateAsset: response.cleanPlateAsset,
					});
					next.assetStatus[response.cleanPlateAsset.id] = {type: 'uploaded'};
					return next;
				},
				commitToUndoStack: true,
			});
			setInpaintWarnings(response.diagnostics.warnings);
			toast.success(t('inpaintReady'));
		} catch (error) {
			if (controller.signal.aborted) return;
			const message = error instanceof Error ? error.message : t('failed');
			toast.error(t('inpaintFailed'), {description: message});
		} finally {
			setInpainting(false);
			if (abortRef.current === controller) {
				abortRef.current = null;
			}
		}
	}, [
		assets,
		fillColor,
		inpaintMode,
		selectedLayerId,
		setState,
		shotId,
		stateRef,
		t,
	]);

	const segmentationProgress =
		segmentationState.status === 'running'
			? segmentationState.progress
			: undefined;

	return (
		<div className="border-editor-starter-surface-separator bg-editor-starter-panel text-editor-starter-text pointer-events-auto absolute top-3 bottom-3 left-[66px] z-50 flex w-[390px] flex-col overflow-hidden rounded-[10px] border shadow-[0_24px_70px_var(--color-editor-starter-popover-shadow)]">
			<div className="flex shrink-0 items-center justify-between border-b border-white/5 px-3 py-2.5">
				<div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
					<Sparkles className="size-4 shrink-0" />
					<span className="truncate">{t('title')}</span>
				</div>
				<button
					type="button"
					className="flex size-7 items-center justify-center rounded text-white/55 hover:bg-white/10 hover:text-white"
					onClick={onClose}
					title={t('close')}
					aria-label={t('close')}
				>
					<X className="size-4" />
				</button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-3">
				<section className="space-y-2">
					<div className="text-xs font-semibold text-white/80">
						{t('segmentationTitle')}
					</div>
					<label className="block text-[11px] text-white/55">
						{t('sourceAsset')}
						<select
							className="editor-starter-field mt-1 w-full px-2 py-2 text-xs"
							value={sourceAssetId}
							onChange={(event) => setSourceAssetId(event.target.value)}
						>
							<option value="">{t('selectAsset')}</option>
							{uploadedImageAssets.map((asset) => (
								<option key={asset.id} value={asset.id}>
									{asset.filename}
								</option>
							))}
						</select>
					</label>
					<label className="block text-[11px] text-white/55">
						{t('shot')}
						<select
							className="editor-starter-field mt-1 w-full px-2 py-2 text-xs"
							value={shotId}
							onChange={(event) => setShotId(event.target.value)}
						>
							<option value="">{t('selectShot')}</option>
							{shots.map((shot) => (
								<option key={shot.id} value={shot.id}>
									{shot.name || shot.id}
								</option>
							))}
						</select>
					</label>
					<label className="block text-[11px] text-white/55">
						{t('semanticHints')}
						<input
							className="editor-starter-field mt-1 w-full px-2 py-2 text-xs"
							value={semanticHints}
							placeholder={t('semanticHintsPlaceholder')}
							onChange={(event) => setSemanticHints(event.target.value)}
						/>
					</label>
					<button
						type="button"
						className="bg-editor-starter-accent text-editor-starter-on-accent flex h-9 w-full items-center justify-center gap-2 rounded px-3 text-xs font-semibold hover:brightness-110 disabled:opacity-40"
						disabled={
							segmentationState.status === 'running' ||
							uploadedImageAssets.length === 0 ||
							shots.length === 0
						}
						onClick={runSegmentation}
					>
						{segmentationState.status === 'running' ? (
							<LoaderCircle className="size-4 animate-spin" />
						) : (
							<Sparkles className="size-4" />
						)}
						{segmentationState.status === 'running'
							? t('running')
							: t('requestSegmentation')}
					</button>
					{segmentationState.status === 'running' ? (
						<div className="space-y-1">
							<div className="flex justify-between text-[10px] text-white/50">
								<span>{segmentationState.jobId || t('queued')}</span>
								<span>
									{segmentationProgress === undefined
										? '...'
										: `${Math.round(segmentationProgress * 100)}%`}
								</span>
							</div>
							<div className="h-1 overflow-hidden rounded bg-white/10">
								<div
									className="bg-editor-starter-accent h-full transition-all"
									style={{
										width: `${Math.round((segmentationProgress ?? 0) * 100)}%`,
									}}
								/>
							</div>
							<button
								type="button"
								className="text-[11px] text-white/55 hover:text-white"
								onClick={cancel}
							>
								{t('cancel')}
							</button>
						</div>
					) : null}
					{segmentationState.status === 'done' ? (
						<div className="flex gap-2 rounded border border-emerald-300/15 bg-emerald-300/5 p-2 text-[11px] text-emerald-100/80">
							<CheckCircle2 className="size-4 shrink-0" />
							<span>
								{segmentationState.warnings.length > 0
									? segmentationState.warnings.join(' ')
									: t('segmentationImported')}
							</span>
						</div>
					) : null}
					{segmentationState.status === 'failed' ? (
						<div className="flex gap-2 rounded border border-red-300/15 bg-red-400/8 p-2 text-[11px] leading-5 text-red-100">
							<AlertTriangle className="mt-0.5 size-4 shrink-0" />
							<span>{segmentationState.message}</span>
						</div>
					) : null}
				</section>

				<section className="mt-4 space-y-2 border-t border-white/8 pt-4">
					<div className="text-xs font-semibold text-white/80">
						{t('inpaintTitle')}
					</div>
					<label className="block text-[11px] text-white/55">
						{t('manualLayer')}
						<select
							className="editor-starter-field mt-1 w-full px-2 py-2 text-xs"
							value={selectedLayerId}
							onChange={(event) => setSelectedLayerId(event.target.value)}
						>
							<option value="">{t('selectLayer')}</option>
							{manualLayers.map((layer) => (
								<option key={layer.id} value={layer.id}>
									{layer.name}
								</option>
							))}
						</select>
					</label>
					<label className="block text-[11px] text-white/55">
						{t('mode')}
						<select
							className="editor-starter-field mt-1 w-full px-2 py-2 text-xs"
							value={inpaintMode}
							onChange={(event) =>
								setInpaintMode(event.target.value as CleanPlateInpaintMode)
							}
						>
							<option value="ai-inpaint">{t('modes.ai')}</option>
							<option value="opencv-inpaint">{t('modes.opencv')}</option>
							<option value="clone-fill">{t('modes.clone')}</option>
							<option value="solid-fill">{t('modes.solid')}</option>
						</select>
					</label>
					{inpaintMode === 'solid-fill' ? (
						<label className="flex items-center justify-between text-[11px] text-white/55">
							<span>{t('fillColor')}</span>
							<input
								type="color"
								value={fillColor}
								onChange={(event) => setFillColor(event.target.value)}
							/>
						</label>
					) : null}
					<button
						type="button"
						className="flex h-9 w-full items-center justify-center gap-2 rounded border border-white/12 bg-white/8 px-3 text-xs font-semibold text-white hover:bg-white/12 disabled:opacity-40"
						disabled={inpainting || !selectedLayerId}
						onClick={runInpaint}
					>
						{inpainting ? (
							<LoaderCircle className="size-4 animate-spin" />
						) : (
							<Sparkles className="size-4" />
						)}
						{inpainting ? t('running') : t('requestInpaint')}
					</button>
					{inpaintWarnings.length > 0 ? (
						<div className="text-[11px] leading-5 text-amber-100/75">
							{inpaintWarnings.join(' ')}
						</div>
					) : null}
				</section>
			</div>
		</div>
	);
};
