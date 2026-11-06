import type {PlayerRef} from '@remotion/player';
import {
	ChevronLeft,
	ChevronRight,
	Diamond,
	Timer,
	TimerOff,
} from 'lucide-react';
import {useMemo} from 'react';
import type {ImageItem} from '../../items/image/image-item-type';
import {evaluateTransformAtFrame} from '../../motion/evaluate';
import {
	findAdjacentTransformPropertyKeyframe,
	hasTransformPropertyKeyframeAt,
	isTransformPropertyAnimated,
	type TransformTimelineProperty,
} from '../../motion/transform-property-timeline';
import {
	type TransformPropertyCommandMode,
	updateTransformPropertyInState,
} from '../../state/actions/update-transform-property';
import {getRectAfterCrop} from '../../utils/get-dimensions-after-crop';
import {useWriteContext} from '../../utils/use-context';
import {useTimelinePosition} from '../../utils/use-timeline-position';
import {TRANSFORM_PROPERTY_ROW_HEIGHT} from './constants';

const labels: Record<TransformTimelineProperty, string> = {
	anchorPoint: 'Anchor Point',
	position: 'Position',
	scale: 'Scale',
	rotation: 'Rotation',
	opacity: 'Opacity',
};

const format = (value: number, digits = 0) =>
	Number.isFinite(value) ? value.toFixed(digits) : '0';

const valueLabel = ({
	item,
	property,
	frame,
}: {
	item: ImageItem;
	property: TransformTimelineProperty;
	frame: number;
}) => {
	const value = evaluateTransformAtFrame(item.motion?.transform, frame, {
		durationInFrames: item.durationInFrames,
	});
	const rect = getRectAfterCrop(item);
	switch (property) {
		case 'anchorPoint':
			return `${format(value.anchorX * 100)}%, ${format(value.anchorY * 100)}%`;
		case 'position':
			return `${format(rect.left + value.x)}, ${format(rect.top + value.y)}`;
		case 'scale':
			return `${format(value.scaleX * 100)}%, ${format(value.scaleY * 100)}%`;
		case 'rotation':
			return `${format(item.rotation + value.rotation, 1)}°`;
		case 'opacity':
			return `${format(Math.min(1, Math.max(0, item.opacity * value.opacity)) * 100)}%`;
	}
};

const valuesAtFrame = ({
	item,
	property,
	frame,
}: {
	item: ImageItem;
	property: TransformTimelineProperty;
	frame: number;
}) => {
	const value = evaluateTransformAtFrame(item.motion?.transform, frame, {
		durationInFrames: item.durationInFrames,
	});
	switch (property) {
		case 'anchorPoint':
			return [value.anchorX, value.anchorY] as const;
		case 'position':
			return [value.x, value.y] as const;
		case 'scale':
			return [value.scaleX, value.scaleY] as const;
		case 'rotation':
			return [value.rotation] as const;
		case 'opacity':
			return [value.opacity] as const;
	}
};

export const TransformPropertyHeaders = ({
	item,
	properties,
	playerRef,
	locked,
}: {
	item: ImageItem;
	properties: readonly TransformTimelineProperty[];
	playerRef: React.RefObject<PlayerRef | null>;
	locked: boolean;
}) => {
	const {setState} = useWriteContext();
	const globalFrame = useTimelinePosition({playerRef});
	const localFrame = Math.max(
		0,
		Math.min(item.durationInFrames - 1, globalFrame - item.from),
	);
	const insideItem =
		globalFrame >= item.from && globalFrame < item.from + item.durationInFrames;
	const transform = item.motion?.transform;
	const disabledReason = locked
		? 'Track or Layer Group is locked. Unlock it to edit Transform.'
		: !insideItem
			? 'The playhead is outside this Item. Move it inside the Item range.'
			: null;

	const rows = useMemo(() => {
		return properties.map((property) => {
			const animated = isTransformPropertyAnimated(transform, property);
			const atKeyframe = hasTransformPropertyKeyframeAt(
				transform,
				property,
				localFrame,
			);
			return {property, animated, atKeyframe};
		});
	}, [localFrame, properties, transform]);

	const update = (
		property: TransformTimelineProperty,
		mode: TransformPropertyCommandMode,
		enabled?: boolean,
	) => {
		setState({
			update: (state) => {
				const current = state.undoableState.items[item.id];
				if (!current || current.type !== 'image') return state;
				const frame = globalFrame - current.from;
				return updateTransformPropertyInState({
					state,
					itemId: current.id,
					globalFrame,
					property,
					mode,
					values: valuesAtFrame({item: current, property, frame}) as never,
					...(enabled === undefined ? {} : {enabled}),
				}).state;
			},
			commitToUndoStack: true,
		});
	};

	return (
		<div
			className="ae-transform-property-headers"
			title={disabledReason ?? undefined}
		>
			{rows.map(({property, animated, atKeyframe}) => {
				const previous = findAdjacentTransformPropertyKeyframe({
					animation: transform,
					property,
					frame: localFrame,
					direction: 'previous',
				});
				const next = findAdjacentTransformPropertyKeyframe({
					animation: transform,
					property,
					frame: localFrame,
					direction: 'next',
				});
				return (
					<div
						key={property}
						className="ae-transform-property-header"
						style={{height: TRANSFORM_PROPERTY_ROW_HEIGHT}}
					>
						<button
							type="button"
							className="ae-property-stopwatch"
							disabled={locked || !insideItem}
							data-active={animated}
							title={
								disabledReason ??
								(animated
									? `Disable ${labels[property]} animation`
									: `Enable ${labels[property]} animation`)
							}
							onClick={() => {
								update(property, 'toggle-animation', !animated);
							}}
						>
							{animated ? <Timer size={13} /> : <TimerOff size={13} />}
						</button>
						<span className="ae-transform-property-name">
							{labels[property]}
						</span>
						<span className="ae-transform-property-value">
							{valueLabel({item, property, frame: localFrame})}
						</span>
						<div className="ae-property-keyframe-controls">
							<button
								type="button"
								disabled={previous === null}
								title="Previous keyframe"
								onClick={() =>
									previous === null
										? null
										: playerRef.current?.seekTo(item.from + previous)
								}
							>
								<ChevronLeft size={12} />
							</button>
							<button
								type="button"
								disabled={locked || !insideItem}
								data-active={atKeyframe}
								title={
									disabledReason ??
									(atKeyframe ? 'Delete keyframe' : 'Add keyframe')
								}
								onClick={() =>
									update(
										property,
										atKeyframe ? 'remove-keyframe' : 'set-keyframe',
									)
								}
							>
								<Diamond
									size={10}
									fill={atKeyframe ? 'currentColor' : 'none'}
								/>
							</button>
							<button
								type="button"
								disabled={next === null}
								title="Next keyframe"
								onClick={() =>
									next === null
										? null
										: playerRef.current?.seekTo(item.from + next)
								}
							>
								<ChevronRight size={12} />
							</button>
						</div>
					</div>
				);
			})}
		</div>
	);
};
