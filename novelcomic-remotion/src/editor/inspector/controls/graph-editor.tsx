'use client';

import React, {useCallback, useMemo, useRef, useState} from 'react';
import {useTranslations} from 'next-intl';
import {sampleCurve} from '../../motion/curve';
import type {TransformKeyframe} from '../../motion/types';

type GraphProperty =
	| 'x'
	| 'y'
	| 'scaleX'
	| 'scaleY'
	| 'rotation'
	| 'opacity';

type DragState =
	| {kind: 'keyframe'; index: number}
	| {kind: 'handle-in'; index: number}
	| {kind: 'handle-out'; index: number};

const WIDTH = 300;
const HEIGHT = 150;
const PADDING = 12;

const defaultValue = (property: GraphProperty): number =>
	property === 'scaleX' || property === 'scaleY' || property === 'opacity'
		? 1
		: 0;

const valueFor = (keyframe: TransformKeyframe, property: GraphProperty) =>
	keyframe[property] ?? defaultValue(property);

const clamp = (value: number, min: number, max: number): number =>
	Math.max(min, Math.min(max, value));

const pointFor = (
	frame: number,
	value: number,
	durationInFrames: number,
	minValue: number,
	maxValue: number,
) => {
	const x =
		PADDING +
		(frame / Math.max(1, durationInFrames - 1)) * (WIDTH - PADDING * 2);
	const progress =
		maxValue === minValue ? 0.5 : (value - minValue) / (maxValue - minValue);
	return {
		x,
		y: HEIGHT - PADDING - clamp(progress, 0, 1) * (HEIGHT - PADDING * 2),
	};
};

const valueFromPoint = (
	x: number,
	y: number,
	durationInFrames: number,
	minValue: number,
	maxValue: number,
) => {
	const frame = Math.round(
		clamp(
			((x - PADDING) / (WIDTH - PADDING * 2)) *
				Math.max(1, durationInFrames - 1),
			0,
			Math.max(0, durationInFrames - 1),
		),
	);
	const value =
		maxValue === minValue
			? minValue
			: maxValue -
				((y - PADDING) / (HEIGHT - PADDING * 2)) *
					(maxValue - minValue);
	return {frame, value};
};

const graphPath = (
	keyframes: readonly TransformKeyframe[],
	property: GraphProperty,
	durationInFrames: number,
	minValue: number,
	maxValue: number,
): string => {
	if (keyframes.length === 0) return '';
	const parts: string[] = [];
	for (let index = 0; index < keyframes.length - 1; index++) {
		const left = keyframes[index]!;
		const right = keyframes[index + 1]!;
		const leftValue = valueFor(left, property);
		const rightValue = valueFor(right, property);
		const sampleCount = Math.max(4, Math.ceil((right.frame - left.frame) / 2));
		for (let sampleIndex = 0; sampleIndex <= sampleCount; sampleIndex++) {
			const frame =
				left.frame + ((right.frame - left.frame) * sampleIndex) / sampleCount;
			const value = sampleCurve(
				[
					{
						frame: left.frame,
						value: leftValue,
						easing: left.easing,
						handleOut: left.handleOut,
					},
					{
						frame: right.frame,
						value: rightValue,
						easing: right.easing,
						handleIn: right.handleIn,
					},
				],
				frame,
				leftValue,
			);
			const point = pointFor(
				frame,
				value,
				durationInFrames,
				minValue,
				maxValue,
			);
			parts.push(`${index === 0 && sampleIndex === 0 ? 'M' : 'L'}${point.x},${point.y}`);
		}
	}
	if (keyframes.length === 1) {
		const point = pointFor(
			keyframes[0]!.frame,
			valueFor(keyframes[0]!, property),
			durationInFrames,
			minValue,
			maxValue,
		);
		return `M${point.x},${point.y}`;
	}
	return parts.join(' ');
};

export const GraphEditor: React.FC<{
	keyframes: readonly TransformKeyframe[];
	durationInFrames: number;
	property: GraphProperty;
	onChange: (keyframes: TransformKeyframe[], commit: boolean) => void;
}> = ({keyframes, durationInFrames, property, onChange}) => {
	const t = useTranslations('editor.actionRow.advanced');
	const svgRef = useRef<SVGSVGElement | null>(null);
	const draftRef = useRef<TransformKeyframe[]>(keyframes.map((item) => ({...item})));
	const [drag, setDrag] = useState<DragState | null>(null);

	const range = useMemo(() => {
		const values = keyframes.map((keyframe) => valueFor(keyframe, property));
		const min = values.length > 0 ? Math.min(...values) : 0;
		const max = values.length > 0 ? Math.max(...values) : 1;
		const padding = Math.max(1, (max - min) * 0.2);
		return {min: min - padding, max: max + padding};
	}, [keyframes, property]);

	const path = useMemo(
		() =>
			graphPath(
				keyframes,
				property,
				durationInFrames,
				range.min,
				range.max,
			),
		[keyframes, durationInFrames, property, range.max, range.min],
	);

	const updateFromPointer = useCallback(
		(event: React.PointerEvent<SVGSVGElement>, commit: boolean) => {
			if (!drag || !svgRef.current) return;
			const rect = svgRef.current.getBoundingClientRect();
			const scaleX = WIDTH / Math.max(1, rect.width);
			const scaleY = HEIGHT / Math.max(1, rect.height);
			const x = (event.clientX - rect.left) * scaleX;
			const y = (event.clientY - rect.top) * scaleY;
			const current = draftRef.current.map((item) => ({...item}));
			const target = current[drag.index];
			if (!target) return;

			if (drag.kind === 'keyframe') {
				const previous = current[drag.index - 1]?.frame ?? 0;
				const next = current[drag.index + 1]?.frame ?? durationInFrames - 1;
				const point = valueFromPoint(
					x,
					y,
					durationInFrames,
					range.min,
					range.max,
				);
				target.frame = clamp(point.frame, previous + 1, Math.max(previous + 1, next - 1));
				target[property] = point.value;
			} else {
				const neighbor =
					drag.kind === 'handle-out'
						? current[drag.index + 1]
						: current[drag.index - 1];
				if (!neighbor) return;
				const start =
					drag.kind === 'handle-out'
						? target
						: neighbor;
				const end =
					drag.kind === 'handle-out'
						? neighbor
						: target;
				const startValue = valueFor(start, property);
				const endValue = valueFor(end, property);
				const point = valueFromPoint(
					x,
					y,
					durationInFrames,
					range.min,
					range.max,
				);
				const segment = Math.max(1, end.frame - start.frame);
				const handle = {
					x: clamp((point.frame - start.frame) / segment, 0, 1),
					y:
						Math.abs(endValue - startValue) < 0.0001
							? 0.5
							: clamp(
									(point.value - startValue) / (endValue - startValue),
									-1,
									2,
								),
				};
				if (drag.kind === 'handle-out') target.handleOut = handle;
				else target.handleIn = handle;
			}

			draftRef.current = current;
			onChange(current, commit);
		},
		[drag, durationInFrames, onChange, property, range.max, range.min],
	);

	const startDrag = (
		event: React.PointerEvent<SVGCircleElement>,
		nextDrag: DragState,
	) => {
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		draftRef.current = keyframes.map((item) => ({...item}));
		setDrag(nextDrag);
	};

	const finishDrag = (event: React.PointerEvent<SVGSVGElement>) => {
		if (!drag) return;
		updateFromPointer(event, true);
		setDrag(null);
	};

	return (
		<div className="space-y-1">
			<svg
				ref={svgRef}
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				className="h-[150px] w-full rounded border border-white/10 bg-black/20 touch-none"
				onPointerMove={(event) => updateFromPointer(event, false)}
				onPointerUp={finishDrag}
				onPointerCancel={finishDrag}
				role="img"
				aria-label={t('graphEditorAria', {property})}
			>
				<path
					d={`M${PADDING},${PADDING}V${HEIGHT - PADDING}H${WIDTH - PADDING}`}
					stroke="rgba(255,255,255,0.16)"
					fill="none"
				/>
				<path
					d={path}
					stroke="var(--color-editor-starter-accent)"
					strokeWidth="2"
					fill="none"
				/>
				{keyframes.map((keyframe, index) => {
					const keyframePoint = pointFor(
						keyframe.frame,
						valueFor(keyframe, property),
						durationInFrames,
						range.min,
						range.max,
					);
					const next = keyframes[index + 1];
					const previous = keyframes[index - 1];
					const out =
						next
							? keyframe.handleOut ?? {x: 0.33, y: 0.33}
							: undefined;
					const incoming =
						previous
							? keyframe.handleIn ?? {x: 0.67, y: 0.67}
							: undefined;
					const outPoint =
						next && out
							? pointFor(
									keyframe.frame +
										(next.frame - keyframe.frame) * out.x,
									valueFor(keyframe, property) +
										(valueFor(next, property) - valueFor(keyframe, property)) *
											out.y,
									durationInFrames,
									range.min,
									range.max,
								)
							: null;
					const inPoint =
						previous && incoming
							? pointFor(
									keyframe.frame -
										(keyframe.frame - previous.frame) * (1 - incoming.x),
									valueFor(previous, property) +
										(valueFor(keyframe, property) - valueFor(previous, property)) *
											incoming.y,
									durationInFrames,
									range.min,
									range.max,
								)
							: null;

					return (
						<g key={`${keyframe.frame}-${index}`}>
							{outPoint ? (
								<>
									<line
										x1={keyframePoint.x}
										y1={keyframePoint.y}
										x2={outPoint.x}
										y2={outPoint.y}
										stroke="rgba(255,255,255,0.25)"
									/>
									<circle
										cx={outPoint.x}
										cy={outPoint.y}
										r={4}
										fill="#f7d049"
										onPointerDown={(event) =>
											startDrag(event, {kind: 'handle-out', index})
										}
									/>
								</>
							) : null}
							{inPoint ? (
								<>
									<line
										x1={keyframePoint.x}
										y1={keyframePoint.y}
										x2={inPoint.x}
										y2={inPoint.y}
										stroke="rgba(255,255,255,0.25)"
									/>
									<circle
										cx={inPoint.x}
										cy={inPoint.y}
										r={4}
										fill="#f7d049"
										onPointerDown={(event) =>
											startDrag(event, {kind: 'handle-in', index})
										}
									/>
								</>
							) : null}
							<circle
								cx={keyframePoint.x}
								cy={keyframePoint.y}
								r={5}
								fill="var(--color-editor-starter-accent)"
								stroke="white"
								strokeWidth="1"
								onPointerDown={(event) =>
									startDrag(event, {kind: 'keyframe', index})
								}
							/>
						</g>
					);
				})}
			</svg>
			<div className="text-[10px] text-editor-starter-text-faint">
				{t('graphHint')}
			</div>
		</div>
	);
};
