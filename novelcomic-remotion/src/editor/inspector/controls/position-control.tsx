import {useTranslations} from 'next-intl';
import React, {memo, useMemo} from 'react';
import {toast} from 'sonner';
import type {MotionDiagnostic} from '../../motion/diagnostics';
import {evaluateTransformAtFrame} from '../../motion/evaluate';
import {useEditorPlayerRef} from '../../player-ref-context';
import {changeItem} from '../../state/actions/change-item';
import {
	setPositionLeft,
	setPositionTop,
} from '../../state/actions/set-position';
import {updateTransformPropertyCommand} from '../../state/actions/update-transform-property';
import {getRectAfterCrop} from '../../utils/get-dimensions-after-crop';
import {useFullState, useItem, useWriteContext} from '../../utils/use-context';
import {useTimelinePosition} from '../../utils/use-timeline-position';
import {InspectorSubLabel} from '../components/inspector-label';
import {ControlsPadding} from './controls-padding';
import {NumberControl, NumberControlUpdateHandler} from './number-controls';

const PositionControlUnmemoized: React.FC<{
	itemId: string;
}> = ({itemId}) => {
	const t = useTranslations('editor.inspector.controls');
	const {setState} = useWriteContext();
	const item = useItem(itemId);
	const autoKeyEnabled = useFullState().autoKeyEnabled;
	const playerRef = useEditorPlayerRef();
	const globalFrame = useTimelinePosition({playerRef});
	const localFrame = globalFrame - item.from;
	const transform =
		item.type === 'image'
			? evaluateTransformAtFrame(item.motion?.transform, localFrame, {
					durationInFrames: item.durationInFrames,
				})
			: null;

	const rectAfterCrop = useMemo(() => getRectAfterCrop(item), [item]);
	const displayedLeft = rectAfterCrop.left + (transform?.x ?? 0);
	const displayedTop = rectAfterCrop.top + (transform?.y ?? 0);

	const showBlockedMessage = React.useCallback(
		(diagnostic: MotionDiagnostic) => {
			toast.warning(diagnostic.message, {description: diagnostic.repair});
		},
		[],
	);

	const onLeft: NumberControlUpdateHandler = React.useCallback(
		({num: requestedLeft, commitToUndoStack}) => {
			if (item.type === 'image') {
				const preview = updateTransformPropertyCommand({
					motion: item.motion ?? {},
					itemId,
					property: 'position',
					frame: localFrame,
					durationInFrames: item.durationInFrames,
					values: [requestedLeft - rectAfterCrop.left, transform?.y ?? 0],
					autoKeyEnabled,
					mode: 'write',
				});
				if (preview.status === 'blocked') {
					if (commitToUndoStack) showBlockedMessage(preview.diagnostic);
					return;
				}
			}
			setState({
				update: (state) => {
					return changeItem(state, itemId, (i) => {
						const currentRectAfterCrop = getRectAfterCrop(i);
						if (i.type === 'image') {
							const currentTransform = evaluateTransformAtFrame(
								i.motion?.transform,
								localFrame,
								{durationInFrames: i.durationInFrames},
							);
							const write = updateTransformPropertyCommand({
								motion: i.motion ?? {},
								itemId: i.id,
								property: 'position',
								frame: localFrame,
								durationInFrames: i.durationInFrames,
								values: [
									Math.round(requestedLeft - currentRectAfterCrop.left),
									currentTransform.y,
								],
								autoKeyEnabled,
								mode: 'write',
							});
							if (write.status === 'blocked') {
								return i;
							}
							return {...i, motion: write.motion};
						}
						const diff = i.left - currentRectAfterCrop.left;
						const num = requestedLeft - (transform?.x ?? 0) + diff;

						return setPositionLeft({item: i, left: num});
					});
				},
				commitToUndoStack,
			});
		},
		[
			autoKeyEnabled,
			item,
			itemId,
			localFrame,
			rectAfterCrop.left,
			setState,
			showBlockedMessage,
			transform?.x,
			transform?.y,
		],
	);

	const onTop: NumberControlUpdateHandler = React.useCallback(
		({num: requestedTop, commitToUndoStack}) => {
			if (item.type === 'image') {
				const preview = updateTransformPropertyCommand({
					motion: item.motion ?? {},
					itemId,
					property: 'position',
					frame: localFrame,
					durationInFrames: item.durationInFrames,
					values: [transform?.x ?? 0, requestedTop - rectAfterCrop.top],
					autoKeyEnabled,
					mode: 'write',
				});
				if (preview.status === 'blocked') {
					if (commitToUndoStack) showBlockedMessage(preview.diagnostic);
					return;
				}
			}
			setState({
				update: (state) => {
					return changeItem(state, itemId, (i) => {
						const currentRectAfterCrop = getRectAfterCrop(i);
						if (i.type === 'image') {
							const currentTransform = evaluateTransformAtFrame(
								i.motion?.transform,
								localFrame,
								{durationInFrames: i.durationInFrames},
							);
							const write = updateTransformPropertyCommand({
								motion: i.motion ?? {},
								itemId: i.id,
								property: 'position',
								frame: localFrame,
								durationInFrames: i.durationInFrames,
								values: [
									currentTransform.x,
									Math.round(requestedTop - currentRectAfterCrop.top),
								],
								autoKeyEnabled,
								mode: 'write',
							});
							if (write.status === 'blocked') {
								return i;
							}
							return {...i, motion: write.motion};
						}
						const diff = i.top - currentRectAfterCrop.top;
						const num = requestedTop - (transform?.y ?? 0) + diff;

						return setPositionTop({item: i, top: num});
					});
				},
				commitToUndoStack,
			});
		},
		[
			autoKeyEnabled,
			item,
			itemId,
			localFrame,
			rectAfterCrop.top,
			setState,
			showBlockedMessage,
			transform?.x,
			transform?.y,
		],
	);

	return (
		<div>
			<InspectorSubLabel>{t('position')}</InspectorSubLabel>
			<div className="flex gap-2">
				<div className="flex-1">
					<NumberControl
						label="X"
						setValue={onLeft}
						value={Math.floor(displayedLeft)}
						min={null}
						max={null}
						step={1}
						accessibilityLabel="X"
					/>
				</div>
				<div className="flex-1">
					<NumberControl
						label="Y"
						setValue={onTop}
						value={Math.floor(displayedTop)}
						min={null}
						max={null}
						step={1}
						accessibilityLabel="Y"
					/>
				</div>
				<ControlsPadding />
			</div>
		</div>
	);
};

export const PositionControl = memo(PositionControlUnmemoized);
