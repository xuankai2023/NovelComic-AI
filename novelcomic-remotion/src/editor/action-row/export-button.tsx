import {Button, Popover} from '@heroui/react';
import {Download, Upload} from 'lucide-react';
import {useTranslations} from 'next-intl';
import React from 'react';
import {
	FEATURE_DOWNLOAD_STATE,
	FEATURE_LOAD_STATE,
	FEATURE_RENDERING,
	FEATURE_SAVE_BUTTON,
} from '../flags';
import {useProjectContext} from '../project/project-context';
import {getCurrentSnapshot} from '../project/project-store';
import {triggerLambdaRender} from '../rendering/render-state';
import {clsx} from '../utils/clsx';
import {isTimelineEmpty} from '../utils/is-timeline-empty';
import {
	useCurrentStateAsRef,
	useTracks,
	useWriteContext,
} from '../utils/use-context';
import {DeliveryPackageButton} from './delivery-package-button';
import {DownloadStateButton} from './download-state-button';
import {LoadStateButton} from './load-state-button';
import {SaveButton} from './save-button';

export const ExportButton: React.FC = () => {
	const t = useTranslations('editor.actionRow.export');
	const {setState} = useWriteContext();
	const state = useCurrentStateAsRef();
	const {tracks} = useTracks();
	const {activeProject, isReadOnly, saveNow} = useProjectContext();
	const isRenderDisabled = isTimelineEmpty(tracks);

	const onRender = React.useCallback(async () => {
		if (!activeProject || isReadOnly) return;
		if (!(await saveNow('manual'))) return;
		const snapshot = await getCurrentSnapshot(activeProject.projectId);
		if (!snapshot) return;
		const {
			assets,
			tracks: _tracks,
			items,
			compositionHeight,
			compositionWidth,
			fps,
			shots,
			advanced,
			propertyGraph,
		} = state.current.undoableState;

		const {getCompositionDuration} =
			await import('../utils/get-composition-duration');
		const durationInFrames = getCompositionDuration(Object.values(items));

		await triggerLambdaRender({
			compositionHeight,
			compositionWidth,
			compositionDurationInSeconds: durationInFrames / fps,
			fps,
			setState,
			tracks: _tracks,
			assets,
			items,
			codec: 'h264',
			shots: shots ?? [],
			advanced,
			propertyGraph,
			projectId: activeProject.projectId,
			inputSnapshotId: snapshot.snapshotId,
			inputContentHash: snapshot.contentHash,
			inputRevision: snapshot.revision,
			projectName: activeProject.name,
		});
	}, [activeProject, isReadOnly, saveNow, setState, state]);

	return (
		<Popover>
			<Popover.Trigger>
				<Button
					variant="ghost"
					className={clsx(
						'border-editor-starter-accent/20 bg-editor-starter-accent text-editor-starter-on-accent h-11 rounded-xl border px-4 text-sm font-semibold shadow-[0_10px_24px_rgba(10,132,255,0.22)] transition-colors',
						'hover:bg-editor-starter-accent/90 data-[hover=true]:bg-editor-starter-accent/90',
					)}
				>
					<Upload className="size-4" strokeWidth={2.25} />
					<span>{t('trigger')}</span>
				</Button>
			</Popover.Trigger>
			<Popover.Content
				placement="bottom end"
				offset={10}
				shouldFlip={false}
				className="bg-editor-starter-panel text-editor-starter-text border-editor-starter-surface-separator w-[360px] rounded-[22px] border p-0 shadow-[0_22px_70px_var(--color-editor-starter-popover-shadow)]"
			>
				<Popover.Dialog className="outline-none">
					<div className="flex flex-col gap-5 p-1">
						<div className="text-editor-starter-text text-[15px] font-semibold">
							{t('panelTitle')}
						</div>

						{FEATURE_SAVE_BUTTON ||
						FEATURE_DOWNLOAD_STATE ||
						FEATURE_LOAD_STATE ? (
							<div className="flex flex-col gap-2">
								{FEATURE_SAVE_BUTTON ? <SaveButton variant="popover" /> : null}
								{FEATURE_DOWNLOAD_STATE ? (
									<DownloadStateButton variant="popover" />
								) : null}
								{FEATURE_LOAD_STATE ? (
									<LoadStateButton variant="popover" />
								) : null}
							</div>
						) : null}

						<div className="bg-editor-starter-surface-separator h-px w-full"></div>

						<div className="flex flex-col gap-4">
								<DeliveryPackageButton />
							{FEATURE_RENDERING ? (
								<>
									<div className="bg-editor-starter-surface-separator h-px w-full"></div>
									<div className="flex flex-col gap-3">
										<div className="text-editor-starter-text-muted text-[13px] font-semibold">
											{t('formatLabel')}
										</div>
										<div className="bg-editor-starter-inset text-editor-starter-text border-editor-starter-surface-separator rounded-xl border px-4 py-3 text-sm font-medium">
											MP4 (H.264)
										</div>
										<Button
											fullWidth
											variant="ghost"
											isDisabled={isRenderDisabled}
											onPress={onRender}
											className={clsx(
												'bg-editor-starter-accent text-editor-starter-on-accent hover:bg-editor-starter-accent/90 data-[hover=true]:bg-editor-starter-accent/90 h-12 rounded-xl text-sm font-semibold transition-colors',
												isRenderDisabled && 'opacity-50',
											)}
										>
											<Download className="size-4" strokeWidth={2.1} />
											<span>{t('downloadVideo')}</span>
										</Button>
									</div>
								</>
							) : null}
						</div>
					</div>
				</Popover.Dialog>
			</Popover.Content>
		</Popover>
	);
};
