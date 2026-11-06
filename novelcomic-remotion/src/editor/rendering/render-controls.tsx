import React from 'react';
import {InspectorLabel} from '../inspector/components/inspector-label';
import {InspectorSection} from '../inspector/components/inspector-section';
import {getCompositionDuration} from '../utils/get-composition-duration';
import {useCurrentStateAsRef, useWriteContext} from '../utils/use-context';
import {useProjectContext} from '../project/project-context';
import {getCurrentSnapshot} from '../project/project-store';
import {runRenderPreflight} from './render-preflight';
import {triggerLambdaRender} from './render-state';
import {TriggerRenderButton} from './trigger-render-button';

export const RenderControls: React.FC = () => {
	const {setState} = useWriteContext();
	const state = useCurrentStateAsRef();
	const {activeProject, isReadOnly, saveNow} = useProjectContext();
	const [preflightMessage, setPreflightMessage] = React.useState<string | null>(
		null,
	);
	const [checking, setChecking] = React.useState(false);

	const onClick = React.useCallback(async () => {
		setChecking(true);
		setPreflightMessage(null);
		try {
		if (!activeProject || isReadOnly) return;
		if (!(await saveNow('manual'))) return;
		const snapshot = await getCurrentSnapshot(activeProject.projectId);
		if (!snapshot) return;
		const {
			assets,
			tracks,
			items,
			compositionHeight,
			compositionWidth,
			fps,
			shots,
			advanced,
			propertyGraph,
		} = state.current.undoableState;

		const durationInFrames = getCompositionDuration(Object.values(items));
		let preflight = await runRenderPreflight({
			project: state.current.undoableState,
			snapshot,
			purpose: 'full-video',
		});
		if (preflight.status === 'blocked') {
			setPreflightMessage(
				preflight.issues.map((issue) => `${issue.code}: ${issue.message}`).join(' · '),
			);
			return;
		}
		let warningsConfirmed = false;
		if (preflight.requiresConfirmation) {
			warningsConfirmed = window.confirm(
				`Render warnings:\n${preflight.issues
					.filter((issue) => issue.severity === 'warning')
					.map((issue) => `• ${issue.message}`)
					.join('\n')}\n\nSubmit anyway?`,
			);
			if (!warningsConfirmed) return;
			preflight = await runRenderPreflight({
				project: state.current.undoableState,
				snapshot,
				purpose: 'full-video',
				warningsConfirmed: true,
			});
		}

		await triggerLambdaRender({
			compositionHeight,
			compositionWidth,
			compositionDurationInSeconds: durationInFrames / fps,
			fps,
			setState,
			tracks,
			assets,
			items,
			codec: 'h264',
			shots: shots ?? [],
			advanced,
			propertyGraph,
			projectId: activeProject.projectId,
			inputSnapshotId: snapshot.snapshotId,
			inputContentHash: snapshot.contentHash,
			preflightHash: preflight.preflightHash,
			warningsConfirmed,
			inputRevision: snapshot.revision,
			projectName: activeProject.name,
		});
		} catch (error) {
			setPreflightMessage(
				error instanceof Error ? error.message : 'Render preflight failed.',
			);
		} finally {
			setChecking(false);
		}
	}, [activeProject, isReadOnly, saveNow, setState, state]);

	return (
		<InspectorSection>
			<InspectorLabel>Export</InspectorLabel>
			<div className="h-2"></div>
			<div className="w-full">
				<div className="mb-3">
					<div className="text-editor-starter-text-muted border-editor-starter-surface-separator w-full rounded border px-3 py-2 text-xs">
						MP4 (H.264)
					</div>
				</div>
				<TriggerRenderButton onTrigger={onClick} disabled={checking} />
				{preflightMessage ? (
					<div className="mt-2 text-xs text-red-300">{preflightMessage}</div>
				) : null}
			</div>
		</InspectorSection>
	);
};
