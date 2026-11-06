import type {PlayerRef} from '@remotion/player';
import {
	ChevronLeft,
	ChevronRight,
	Diamond,
	Timer,
	TimerOff,
} from 'lucide-react';
import React, {useCallback} from 'react';
import {toast} from 'sonner';
import type {ImageItem} from '../../items/image/image-item-type';
import {evaluateTransformAtFrame} from '../../motion/evaluate';
import {
	disableTransformPropertyAnimation,
	findAdjacentTransformPropertyKeyframe,
	hasTransformPropertyKeyframeAt,
	isTransformPropertyAnimated,
	removeTransformPropertyKeyframe,
	type TransformTimelineProperty,
	type TransformTimelineValues,
	upsertTransformPropertyKeyframe,
} from '../../motion/transform-property-timeline';
import {useEditorPlayerRef} from '../../player-ref-context';
import {changeItem} from '../../state/actions/change-item';
import {
	isItemOnLockedLayerGroup,
	isTrackHiddenByLayerGroup,
} from '../../state/actions/layer-groups';
import {updateTransformPropertyCommand} from '../../state/actions/update-transform-property';
import {getRectAfterCrop} from '../../utils/get-dimensions-after-crop';
import {
	useFullState,
	useTracks,
	useWriteContext,
} from '../../utils/use-context';
import {useTimelinePosition} from '../../utils/use-timeline-position';
import {InspectorSubLabel} from '../components/inspector-label';
import {
	NumberControl,
	type NumberControlUpdateHandler,
} from './number-controls';

type PropertyConfig = {
	property: TransformTimelineProperty;
	label: string;
	unit: 'px' | '%' | 'deg';
	step: number;
};

const PROPERTY_CONFIGS: readonly PropertyConfig[] = [
	{property: 'anchorPoint', label: 'Anchor Point', unit: '%', step: 1},
	{property: 'position', label: 'Position', unit: 'px', step: 1},
	{property: 'scale', label: 'Scale', unit: '%', step: 1},
	{property: 'rotation', label: 'Rotation', unit: 'deg', step: 1},
	{property: 'opacity', label: 'Opacity', unit: '%', step: 1},
];

const clampOpacity = (value: number) => Math.min(1, Math.max(0, value));

const getPropertyValues = ({
	item,
	property,
	frame,
}: {
	item: ImageItem;
	property: TransformTimelineProperty;
	frame: number;
}) => {
	const transform = evaluateTransformAtFrame(item.motion?.transform, frame, {
		durationInFrames: item.durationInFrames,
	});
	const rect = getRectAfterCrop(item);

	switch (property) {
		case 'anchorPoint':
			return {
				values: [transform.anchorX * 100, transform.anchorY * 100] as const,
				labels: ['X', 'Y'] as const,
			};
		case 'position':
			return {
				values: [rect.left + transform.x, rect.top + transform.y] as const,
				labels: ['X', 'Y'] as const,
			};
		case 'scale':
			return {
				values: [transform.scaleX * 100, transform.scaleY * 100] as const,
				labels: ['X', 'Y'] as const,
			};
		case 'rotation':
			return {
				values: [item.rotation + transform.rotation] as const,
				labels: [''] as const,
			};
		case 'opacity':
			return {
				values: [clampOpacity(item.opacity * transform.opacity) * 100] as const,
				labels: [''] as const,
			};
	}
};

const getCommandValues = ({
	item,
	property,
	frame,
	nextValue,
	axis,
}: {
	item: ImageItem;
	property: TransformTimelineProperty;
	frame: number;
	nextValue: number;
	axis: 0 | 1;
}) => {
	const transform = evaluateTransformAtFrame(item.motion?.transform, frame, {
		durationInFrames: item.durationInFrames,
	});
	const rect = getRectAfterCrop(item);

	switch (property) {
		case 'anchorPoint':
			return [
				axis === 0 ? nextValue / 100 : transform.anchorX,
				axis === 1 ? nextValue / 100 : transform.anchorY,
			] as [number, number];
		case 'position':
			return [
				axis === 0 ? nextValue - rect.left : transform.x,
				axis === 1 ? nextValue - rect.top : transform.y,
			] as [number, number];
		case 'scale':
			return [
				axis === 0 ? nextValue / 100 : transform.scaleX,
				axis === 1 ? nextValue / 100 : transform.scaleY,
			] as [number, number];
		case 'rotation':
			return [nextValue - item.rotation] as [number];
		case 'opacity':
			return [item.opacity > 0 ? nextValue / 100 / item.opacity : 0] as [
				number,
			];
	}
};

const format = (value: number) =>
	Number.isFinite(value) ? Number(value.toFixed(2)) : 0;

const TransformPropertyRow: React.FC<{
	item: ImageItem;
	config: PropertyConfig;
	frame: number;
	playerRef: React.RefObject<PlayerRef | null>;
	locked: boolean;
	insideItem: boolean;
}> = ({item, config, frame, playerRef, locked, insideItem}) => {
	const {setState} = useWriteContext();
	const transform = item.motion?.transform;
	const animated = isTransformPropertyAnimated(transform, config.property);
	const atKeyframe = hasTransformPropertyKeyframeAt(
		transform,
		config.property,
		frame,
	);
	const previous = findAdjacentTransformPropertyKeyframe({
		animation: transform,
		property: config.property,
		frame,
		direction: 'previous',
	});
	const next = findAdjacentTransformPropertyKeyframe({
		animation: transform,
		property: config.property,
		frame,
		direction: 'next',
	});
	const propertyValues = getPropertyValues({
		item,
		property: config.property,
		frame,
	});
	const writeContext = useFullState();

	const updateAnimation = useCallback(
		(updater: typeof upsertTransformPropertyKeyframe) => {
			setState({
				update: (state) =>
					changeItem(state, item.id, (current) => {
						if (current.type !== 'image') return current;
						const displayed = getPropertyValues({
							item: current,
							property: config.property,
							frame,
						}).values;
						const commandValues = getCommandValues({
							item: current,
							property: config.property,
							frame,
							nextValue: displayed[0],
							axis: 0,
						}) as number[];
						if (displayed.length > 1) {
							const yValues = getCommandValues({
								item: current,
								property: config.property,
								frame,
								nextValue: displayed[1] ?? displayed[0]!,
								axis: 1,
							});
							commandValues[1] = yValues[1] ?? commandValues[1]!;
						}
						const animation = updater({
							animation: current.motion?.transform,
							property: config.property,
							frame,
							values:
								commandValues as TransformTimelineValues[typeof config.property],
						});
						return {
							...current,
							motion: {...(current.motion ?? {}), transform: animation},
						};
					}),
				commitToUndoStack: true,
				command: {
					type: 'property.update',
					mergeKey: `property:${item.id}:${config.property}`,
				},
			});
		},
		[config, frame, item.id, setState],
	);

	const toggleAnimation = useCallback(() => {
		if (locked || !insideItem) return;
		if (animated && transform) {
			setState({
				update: (state) =>
					changeItem(state, item.id, (current) => {
						if (current.type !== 'image' || !current.motion?.transform)
							return current;
						const displayed = getPropertyValues({
							item: current,
							property: config.property,
							frame,
						}).values;
						const values = getCommandValues({
							item: current,
							property: config.property,
							frame,
							nextValue: displayed[0],
							axis: 0,
						});
						const nextTransform = disableTransformPropertyAnimation({
							animation: current.motion.transform,
							property: config.property,
							values: values as never,
						});
						return {
							...current,
							motion: {...current.motion, transform: nextTransform},
						};
					}),
				commitToUndoStack: true,
				command: {type: 'property.update'},
			});
			return;
		}
		updateAnimation(upsertTransformPropertyKeyframe);
	}, [
		animated,
		config.property,
		frame,
		insideItem,
		item,
		locked,
		setState,
		transform,
		updateAnimation,
	]);

	const handleValue = useCallback(
		(axis: 0 | 1): NumberControlUpdateHandler =>
			({num, commitToUndoStack}) => {
				if (locked || !insideItem) {
					if (commitToUndoStack) {
						toast.warning(
							locked
								? '图层已锁定，无法修改属性'
								: '当前时间不在图层范围内，属性为只读',
						);
					}
					return;
				}
				const previewValues = getCommandValues({
					item,
					property: config.property,
					frame,
					nextValue: num,
					axis,
				});
				const preview = updateTransformPropertyCommand({
					motion: item.motion ?? {},
					property: config.property,
					frame,
					durationInFrames: item.durationInFrames,
					values: previewValues as never,
					autoKeyEnabled: writeContext.autoKeyEnabled,
					mode: 'write',
					itemId: item.id,
					readOnly: locked,
				});
				if (preview.status === 'blocked') {
					if (commitToUndoStack) {
						toast.warning(preview.diagnostic.message, {
							description: preview.diagnostic.repair,
						});
					}
					return;
				}
				setState({
					update: (state) =>
						changeItem(state, item.id, (current) => {
							if (current.type !== 'image') return current;
							const currentValues = getCommandValues({
								item: current,
								property: config.property,
								frame,
								nextValue: num,
								axis,
							});
							const result = updateTransformPropertyCommand({
								motion: current.motion ?? {},
								property: config.property,
								frame,
								durationInFrames: current.durationInFrames,
								values: currentValues as never,
								autoKeyEnabled: writeContext.autoKeyEnabled,
								mode: 'write',
								itemId: current.id,
							});
							if (result.status === 'blocked') return current;
							return {...current, motion: result.motion};
						}),
					commitToUndoStack,
				});
			},
		[
			config.property,
			frame,
			insideItem,
			item,
			locked,
			setState,
			writeContext.autoKeyEnabled,
		],
	);

	const values = propertyValues.values;
	const max = config.property === 'opacity' ? 100 : null;
	const min = config.property === 'opacity' ? 0 : null;
	return (
		<div
			className="ae-transform-inspector-row"
			data-disabled={!insideItem || locked}
		>
			<div className="ae-transform-inspector-row-header">
				<button
					type="button"
					className="ae-property-stopwatch"
					disabled={locked || !insideItem}
					data-active={animated}
					title={
						animated ? `关闭 ${config.label} 动画` : `开启 ${config.label} 动画`
					}
					onClick={toggleAnimation}
				>
					{animated ? <Timer size={13} /> : <TimerOff size={13} />}
				</button>
				<InspectorSubLabel className="ae-transform-inspector-property-label">
					{config.label}
				</InspectorSubLabel>
				<div className="ae-transform-inspector-actions">
					<button
						type="button"
						disabled={previous === null}
						title="上一个关键帧"
						onClick={() =>
							previous !== null &&
							playerRef.current?.seekTo(item.from + previous)
						}
					>
						<ChevronLeft size={12} />
					</button>
					<button
						type="button"
						disabled={locked || !insideItem}
						data-active={atKeyframe}
						title={atKeyframe ? '删除当前帧关键帧' : '添加当前帧关键帧'}
						onClick={() => {
							if (!transform) return;
							if (atKeyframe) {
								const nextTransform = removeTransformPropertyKeyframe({
									animation: transform,
									property: config.property,
									frame,
								});
								setState({
									update: (state) =>
										changeItem(state, item.id, (current) =>
											current.type === 'image'
												? {
														...current,
														motion: {
															...current.motion,
															transform: nextTransform ?? undefined,
														},
													}
												: current,
										),
									commitToUndoStack: true,
									command: {type: 'property.update'},
								});
							} else updateAnimation(upsertTransformPropertyKeyframe);
						}}
					>
						<Diamond size={11} fill={atKeyframe ? 'currentColor' : 'none'} />
					</button>
					<button
						type="button"
						disabled={next === null}
						title="下一个关键帧"
						onClick={() =>
							next !== null && playerRef.current?.seekTo(item.from + next)
						}
					>
						<ChevronRight size={12} />
					</button>
				</div>
			</div>
			<div
				className="ae-transform-inspector-values"
				data-single={values.length === 1}
			>
				{values.map((value, axis) => (
					<NumberControl
						key={`${config.property}-${axis}`}
						label={propertyValues.labels[axis] || config.unit}
						value={format(value)}
						setValue={handleValue(axis as 0 | 1)}
						min={min}
						max={max}
						step={config.step}
						accessibilityLabel={`${config.label} ${propertyValues.labels[axis] || config.unit}`}
						disabled={locked || !insideItem}
					/>
				))}
			</div>
		</div>
	);
};

export const TransformPropertyInspector: React.FC<{item: ImageItem}> = ({
	item,
}) => {
	const playerRef = useEditorPlayerRef();
	const globalFrame = useTimelinePosition({playerRef});
	const frame = globalFrame - item.from;
	const insideItem = frame >= 0 && frame < item.durationInFrames;
	const {tracks} = useTracks();
	const fullState = useFullState();
	const itemTrack = tracks.find((track) => track.items.includes(item.id));
	const locked =
		tracks.some((track) => track.locked && track.items.includes(item.id)) ||
		isItemOnLockedLayerGroup(fullState.undoableState, item.id);
	const hidden =
		Boolean(itemTrack?.hidden) ||
		Boolean(
			itemTrack &&
			isTrackHiddenByLayerGroup(fullState.undoableState, itemTrack.id),
		);
	const disabledReason = locked
		? '图层或图层组已锁定，请先解锁'
		: hidden
			? '轨道或图层组已隐藏，请先显示'
			: !insideItem
				? '当前时间不在图层范围内'
				: undefined;

	return (
		<section
			className="ae-transform-inspector"
			aria-label="Transform 属性"
			title={disabledReason}
		>
			<div className="ae-transform-inspector-titlebar">
				<div>
					<div className="ae-transform-inspector-title">Transform</div>
					<div className="ae-transform-inspector-subtitle">
						{disabledReason ?? `当前帧 ${globalFrame}`}
					</div>
				</div>
				<div
					className="ae-transform-inspector-status"
					data-active={!insideItem || locked}
				>
					{locked
						? 'Locked'
						: hidden
							? 'Hidden'
							: insideItem
								? 'Ready'
								: 'Read only'}
				</div>
			</div>
			{PROPERTY_CONFIGS.map((config) => (
				<TransformPropertyRow
					key={config.property}
					item={item}
					config={config}
					frame={Math.max(0, Math.min(item.durationInFrames - 1, frame))}
					playerRef={playerRef}
					locked={locked || hidden}
					insideItem={insideItem}
				/>
			))}
		</section>
	);
};
