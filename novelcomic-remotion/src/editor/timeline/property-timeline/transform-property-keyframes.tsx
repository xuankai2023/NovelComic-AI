import type {PlayerRef} from '@remotion/player';
import {useCallback, useRef} from 'react';
import type {ImageItem} from '../../items/image/image-item-type';
import {
	getTransformPropertyKeyframes,
	moveTransformPropertyKeyframe,
	type TransformTimelineProperty,
} from '../../motion/transform-property-timeline';
import {restoreItemsAfterCancelledDrag} from '../../state/actions/cancel-item-drag';
import {changeItem} from '../../state/actions/change-item';
import {getItemLeftOffset} from '../../utils/position-utils';
import {useWriteContext} from '../../utils/use-context';
import {useTimelinePosition} from '../../utils/use-timeline-position';
import {useTimelineSize} from '../utils/use-timeline-size';
import {TRANSFORM_PROPERTY_ROW_HEIGHT} from './constants';

export const TransformPropertyKeyframes = ({
	item,
	properties,
	playerRef,
	visibleFrames,
	top,
	locked,
}: {
	item: ImageItem;
	properties: readonly TransformTimelineProperty[];
	playerRef: React.RefObject<PlayerRef | null>;
	visibleFrames: number;
	top: number;
	locked: boolean;
}) => {
	const {timelineWidth} = useTimelineSize();
	const currentFrame = useTimelinePosition({playerRef});
	const {setState} = useWriteContext();
	const keyframesRef = useRef<HTMLDivElement>(null);

	const moveKeyframe = useCallback(
		({
			property,
			fromFrame,
			toFrame,
			commit,
		}: {
			property: TransformTimelineProperty;
			fromFrame: number;
			toFrame: number;
			commit: boolean;
		}) => {
			if (fromFrame === toFrame) return;
			setState({
				update: (state) =>
					changeItem(state, item.id, (current) => {
						if (current.type !== 'image' || !current.motion?.transform) {
							return current;
						}
						const transform = moveTransformPropertyKeyframe({
							animation: current.motion.transform,
							property,
							frame: fromFrame,
							toFrame,
							durationInFrames: current.durationInFrames,
						});
						return {
							...current,
							motion: {...current.motion, transform},
						};
					}),
				commitToUndoStack: commit,
				command: commit
					? {
							type: 'property.update',
							mergeKey: `keyframe:${item.id}:${property}`,
						}
					: undefined,
			});
		},
		[item.id, setState],
	);

	const handlePointerDown = useCallback(
		(
			event: React.PointerEvent<HTMLButtonElement>,
			property: TransformTimelineProperty,
			frame: number,
		) => {
			if (locked) return;
			event.preventDefault();
			event.stopPropagation();
			const target = keyframesRef.current;
			if (!target) return;
			const startRect = target.getBoundingClientRect();
			const initialItem = item;
			let movingFrame = frame;
			let didMove = false;
			const getFrame = (clientX: number) => {
				const ratio = Math.max(
					0,
					Math.min(1, (clientX - startRect.left) / startRect.width),
				);
				return Math.max(
					0,
					Math.min(
						item.durationInFrames - 1,
						Math.round(ratio * (visibleFrames - 1)) - item.from,
					),
				);
			};
			const onMove = (moveEvent: PointerEvent) => {
				const nextFrame = getFrame(moveEvent.clientX);
				if (nextFrame === movingFrame) return;
				moveKeyframe({
					property,
					fromFrame: movingFrame,
					toFrame: nextFrame,
					commit: false,
				});
				movingFrame = nextFrame;
				didMove = true;
			};
			const cleanup = () => {
				window.removeEventListener('pointermove', onMove);
				window.removeEventListener('pointerup', onUp);
				window.removeEventListener('pointercancel', onCancel);
				window.removeEventListener('keydown', onKeyDown);
			};
			const onCancel = () => {
				if (didMove) {
					setState({
						update: (state) =>
							restoreItemsAfterCancelledDrag({
								state,
								snapshots: [initialItem],
							}),
						commitToUndoStack: false,
						cancelTransient: true,
					});
				}
				cleanup();
			};
			const onKeyDown = (keyEvent: KeyboardEvent) => {
				if (
					keyEvent.key === 'Escape' ||
					((keyEvent.metaKey || keyEvent.ctrlKey) &&
						keyEvent.key.toLowerCase() === 'z')
				) {
					keyEvent.preventDefault();
					onCancel();
				}
			};
			const onUp = (upEvent: PointerEvent) => {
				const nextFrame = getFrame(upEvent.clientX);
				let committed = false;
				if (nextFrame !== movingFrame) {
					moveKeyframe({
						property,
						fromFrame: movingFrame,
						toFrame: nextFrame,
						commit: true,
					});
					didMove = true;
					committed = true;
				}
				if (didMove && !committed) {
					// The last preview update is intentionally transient. A final no-op
					// update commits the current state as one undo step.
					setState({
						update: (state) => state,
						commitToUndoStack: true,
						command: {
							type: 'property.update',
							mergeKey: `keyframe:${item.id}:${property}`,
						},
					});
				}
				playerRef.current?.seekTo(item.from + nextFrame);
				cleanup();
			};
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onUp);
			window.addEventListener('pointercancel', onCancel);
			window.addEventListener('keydown', onKeyDown);
		},
		[item, locked, moveKeyframe, playerRef, setState, visibleFrames],
	);
	if (timelineWidth === null) return null;

	return (
		<div
			ref={keyframesRef}
			className="ae-transform-property-keyframes"
			style={{top}}
		>
			{properties.map((property) => (
				<div
					key={property}
					className="ae-transform-property-keyframe-row"
					style={{height: TRANSFORM_PROPERTY_ROW_HEIGHT}}
				>
					{getTransformPropertyKeyframes(item.motion?.transform, property).map(
						(frame) => {
							const globalFrame = item.from + frame;
							const left = getItemLeftOffset({
								timelineWidth,
								totalDurationInFrames: visibleFrames,
								from: globalFrame,
							});
							const active = currentFrame === globalFrame;
							return (
								<button
									key={frame}
									type="button"
									className="ae-keyframe-diamond"
									data-active={active}
									style={{left}}
									title={`Frame ${globalFrame}`}
									disabled={locked}
									onPointerDown={(event) =>
										handlePointerDown(event, property, frame)
									}
								/>
							);
						},
					)}
				</div>
			))}
		</div>
	);
};
