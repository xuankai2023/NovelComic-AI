'use client';

import React from 'react';
import {selectionFigures, type SelectionFigure} from '../../document/selection-geometry';
import type {SelectionRecord} from '../../document/types';
import type {ToolOverlayState} from '../types';

const lassoPoints = (draft: NonNullable<ToolOverlayState['selectionDraft']>) => {
	const points = draft.points ?? [];
	if (draft.polygonal && draft.cursor) return [...points, draft.cursor];
	return points;
};

const CloneStampPreview: React.FC<{
	pixels: {width: number; height: number; data: Uint8ClampedArray};
	left: number;
	top: number;
	size: number;
	opacity: number;
}> = ({pixels, left, top, size, opacity}) => {
	const ref = React.useRef<HTMLCanvasElement>(null);
	React.useEffect(() => {
		const canvas = ref.current;
		const context = canvas?.getContext('2d');
		if (!canvas || !context) return;
		context.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
	}, [pixels]);
	return (
		<canvas
			ref={ref}
			width={pixels.width}
			height={pixels.height}
			aria-hidden="true"
			className="pointer-events-none absolute"
			style={{left, top, width: size, height: size, opacity, borderRadius: '50%'}}
		/>
	);
};

const figureProps = (figure: SelectionFigure, key: string) =>
	figure.kind === 'ellipse' ? (
		<ellipse
			key={key}
			cx={figure.bounds.x + figure.bounds.width / 2}
			cy={figure.bounds.y + figure.bounds.height / 2}
			rx={figure.bounds.width / 2}
			ry={figure.bounds.height / 2}
		/>
	) : (
		<path key={key} d={figure.d} />
	);

export const ToolOverlayRoot: React.FC<{
	state: ToolOverlayState | null;
	scale: number;
	selection?: SelectionRecord | null;
}> = ({state, scale, selection}) => {
	const draft = state?.selectionDraft;
	const marqueeDraft = draft?.kind === 'rectangle' || draft?.kind === 'ellipse';
	const bounds = marqueeDraft ? null : draft?.bounds;
	const transform = state?.transform;
	const top = transform?.handles.find((handle) => handle.kind === 'n')?.point;
	const ants = selectionFigures(selection);
	const showDraft = Boolean(marqueeDraft && draft?.bounds && (draft.bounds.width > 0 || draft.bounds.height > 0));
	if (!state && !ants.length) return null;
	return (
		<div className="pointer-events-none absolute inset-0 overflow-visible">
			<style>{'@keyframes marquee-ants { to { stroke-dashoffset: -8; } }'}</style>
			{ants.length ? (
				<svg className="absolute inset-0 h-full w-full overflow-visible">
					<g transform={`scale(${scale})`} fill="none" strokeWidth="1" vectorEffect="non-scaling-stroke">
						{ants.map((figure, index) =>
							React.cloneElement(figureProps(figure, `ant-${index}`), {
								stroke: 'white',
								vectorEffect: 'non-scaling-stroke',
							}),
						)}
						{ants.map((figure, index) =>
							React.cloneElement(figureProps(figure, `ant-dash-${index}`), {
								stroke: 'black',
								strokeDasharray: '4 4',
								vectorEffect: 'non-scaling-stroke',
								style: {animation: 'marquee-ants .96s linear infinite'},
							}),
						)}
					</g>
				</svg>
			) : null}
			{showDraft && draft?.bounds ? (
				<svg className="absolute inset-0 h-full w-full overflow-visible">
					<g transform={`scale(${scale})`} fill="none" vectorEffect="non-scaling-stroke">
						{draft.kind === 'ellipse' ? (
							<>
								<ellipse
									cx={draft.bounds.x + draft.bounds.width / 2}
									cy={draft.bounds.y + draft.bounds.height / 2}
									rx={Math.abs(draft.bounds.width) / 2}
									ry={Math.abs(draft.bounds.height) / 2}
									stroke="black"
									strokeWidth="2"
									vectorEffect="non-scaling-stroke"
								/>
								<ellipse
									cx={draft.bounds.x + draft.bounds.width / 2}
									cy={draft.bounds.y + draft.bounds.height / 2}
									rx={Math.abs(draft.bounds.width) / 2}
									ry={Math.abs(draft.bounds.height) / 2}
									stroke="white"
									strokeWidth="1"
									vectorEffect="non-scaling-stroke"
								/>
							</>
						) : (
							<>
								<rect
									x={draft.bounds.x}
									y={draft.bounds.y}
									width={draft.bounds.width}
									height={draft.bounds.height}
									stroke="black"
									strokeWidth="2"
									vectorEffect="non-scaling-stroke"
								/>
								<rect
									x={draft.bounds.x}
									y={draft.bounds.y}
									width={draft.bounds.width}
									height={draft.bounds.height}
									stroke="white"
									strokeWidth="1"
									vectorEffect="non-scaling-stroke"
								/>
							</>
						)}
					</g>
				</svg>
			) : null}
			{bounds ? (
				<div
					className="absolute border border-dashed border-cyan-200 bg-cyan-300/10"
					style={{
						left: bounds.x * scale,
						top: bounds.y * scale,
						width: bounds.width * scale,
						height: bounds.height * scale,
						borderRadius: draft?.kind === 'ellipse' ? '50%' : undefined,
					}}
				/>
			) : null}
			{draft?.kind === 'lasso' && draft.points?.length ? (
				<svg className="absolute inset-0 h-full w-full overflow-visible">
					<g transform={`scale(${scale})`} fill="none" strokeLinecap="round" strokeLinejoin="round">
						<polyline
							points={lassoPoints(draft).map((point) => `${point.x},${point.y}`).join(' ')}
							stroke="rgba(0,0,0,0.8)"
							strokeWidth="2"
							vectorEffect="non-scaling-stroke"
						/>
						<polyline
							points={lassoPoints(draft).map((point) => `${point.x},${point.y}`).join(' ')}
							stroke="white"
							strokeWidth="1"
							vectorEffect="non-scaling-stroke"
						/>
					</g>
					{draft.polygonal && draft.points[0] ? (
						<rect
							x={draft.points[0].x * scale - 4}
							y={draft.points[0].y * scale - 4}
							width="8"
							height="8"
							fill="white"
							stroke="black"
						/>
					) : null}
				</svg>
			) : null}
			{transform ? (
				<svg className="absolute inset-0 h-full w-full overflow-visible">
					<polygon
						points={transform.corners.map((point) => `${point.x * scale},${point.y * scale}`).join(' ')}
						fill="none"
						stroke="#69a5ff"
						strokeDasharray="5 3"
					/>
					{transform.rotationHandle && top ? (
						<line
							x1={top.x * scale}
							y1={top.y * scale}
							x2={transform.rotationHandle.x * scale}
							y2={transform.rotationHandle.y * scale}
							stroke="#69a5ff"
						/>
					) : null}
					{transform.rotationHandle ? (
						<circle cx={transform.rotationHandle.x * scale} cy={transform.rotationHandle.y * scale} r={5} fill="#15161a" stroke="#69a5ff" />
					) : null}
					{transform.handles.map((handle) => (
						<rect
							key={handle.kind}
							x={handle.point.x * scale - 4}
							y={handle.point.y * scale - 4}
							width="8"
							height="8"
							fill="#15161a"
							stroke="#69a5ff"
						/>
					))}
				</svg>
			) : null}
			{state?.brushCursor?.preview ? (
				<CloneStampPreview
					pixels={state.brushCursor.preview}
					opacity={state.brushCursor.preview.opacity}
					left={(state.brushCursor.x - state.brushCursor.diameter / 2) * scale}
					top={(state.brushCursor.y - state.brushCursor.diameter / 2) * scale}
					size={Math.max(1, state.brushCursor.diameter * scale)}
				/>
			) : null}
			{state?.brushCursor ? (
				<svg className="absolute inset-0 h-full w-full overflow-visible">
					<g transform={`scale(${scale})`} fill="none">
						<circle
							cx={state.brushCursor.x}
							cy={state.brushCursor.y}
							r={Math.max(0.5, state.brushCursor.diameter / 2)}
							stroke="white"
							strokeWidth="2.5"
							vectorEffect="non-scaling-stroke"
						/>
						<circle
							cx={state.brushCursor.x}
							cy={state.brushCursor.y}
							r={Math.max(0.5, state.brushCursor.diameter / 2)}
							stroke="black"
							strokeWidth="1"
							vectorEffect="non-scaling-stroke"
						/>
						{state.brushCursor.hardness && state.brushCursor.hardness > 0 ? (
							<circle
								cx={state.brushCursor.x}
								cy={state.brushCursor.y}
								r={Math.max(0.5, (state.brushCursor.diameter / 2) * state.brushCursor.hardness)}
								stroke="white"
								strokeWidth="1.5"
								strokeDasharray="4 3"
								vectorEffect="non-scaling-stroke"
							/>
						) : null}
					</g>
				</svg>
			) : null}
			{state?.brushCursor?.sample ? (
				<svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
					<g strokeLinecap="round">
						<line
							x1={state.brushCursor.sample.x * scale - 7}
							y1={state.brushCursor.sample.y * scale}
							x2={state.brushCursor.sample.x * scale + 7}
							y2={state.brushCursor.sample.y * scale}
							stroke="white"
							strokeWidth="3"
						/>
						<line
							x1={state.brushCursor.sample.x * scale}
							y1={state.brushCursor.sample.y * scale - 7}
							x2={state.brushCursor.sample.x * scale}
							y2={state.brushCursor.sample.y * scale + 7}
							stroke="white"
							strokeWidth="3"
						/>
						<line
							x1={state.brushCursor.sample.x * scale - 7}
							y1={state.brushCursor.sample.y * scale}
							x2={state.brushCursor.sample.x * scale + 7}
							y2={state.brushCursor.sample.y * scale}
							stroke="black"
							strokeWidth="1"
						/>
						<line
							x1={state.brushCursor.sample.x * scale}
							y1={state.brushCursor.sample.y * scale - 7}
							x2={state.brushCursor.sample.x * scale}
							y2={state.brushCursor.sample.y * scale + 7}
							stroke="black"
							strokeWidth="1"
						/>
					</g>
				</svg>
			) : null}
			{state?.snapGuides?.map((guide, index) =>
				guide.orientation === 'vertical' ? (
					<div key={`x-${index}`} className="absolute top-0 bottom-0 w-px bg-cyan-200/80" style={{left: guide.position * scale}} />
				) : (
					<div key={`y-${index}`} className="absolute right-0 left-0 h-px bg-cyan-200/80" style={{top: guide.position * scale}} />
				),
			)}
		</div>
	);
};
