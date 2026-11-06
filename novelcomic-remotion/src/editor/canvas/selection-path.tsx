import React from 'react';
import {AbsoluteFill} from 'remotion';
import type {ManualLayerPoint} from '../comic/manual-layer-types';

const pointToString = (point: ManualLayerPoint) => {
	return `${point.x},${point.y}`;
};

export const SelectionPath: React.FC<{
	points: readonly ManualLayerPoint[];
	width: number;
	height: number;
	closed: boolean;
	selectedPointIndex: number | null;
	canClose: boolean;
	onPointPointerDown: (
		event: React.PointerEvent<SVGCircleElement>,
		index: number,
	) => void;
}> = ({
	points,
	width,
	height,
	closed,
	selectedPointIndex,
	canClose,
	onPointPointerDown,
}) => {
	if (points.length === 0) {
		return null;
	}

	const pointList = points.map(pointToString).join(' ');
	const pathData =
		points.length >= 2
			? `M ${points.map(pointToString).join(' L ')}${closed ? ' Z' : ''}`
			: null;

	return (
		<AbsoluteFill className="pointer-events-none">
			<svg
				width="100%"
				height="100%"
				viewBox={`0 0 ${width} ${height}`}
				preserveAspectRatio="none"
				className="overflow-visible"
			>
				{closed && pathData ? (
					<path d={pathData} fill="rgba(96, 111, 246, 0.16)" stroke="none" />
				) : null}
				{pathData ? (
					<path
						d={pathData}
						fill="none"
						stroke="rgba(255, 255, 255, 0.88)"
						strokeWidth={1.5}
						strokeDasharray={closed ? undefined : '6 4'}
						vectorEffect="non-scaling-stroke"
					/>
				) : (
					<polyline
						points={pointList}
						fill="none"
						stroke="rgba(255, 255, 255, 0.88)"
						strokeWidth={1.5}
						vectorEffect="non-scaling-stroke"
					/>
				)}
				{points.map((point, index) => {
					const selected = selectedPointIndex === index;
					const firstClosable = index === 0 && canClose && !closed;
					return (
						<circle
							key={`${index}-${point.x}-${point.y}`}
							cx={point.x}
							cy={point.y}
							r={firstClosable ? 6 : selected ? 5 : 4}
							fill={
								selected ? '#F7D049' : firstClosable ? '#6FED7B' : '#606FF6'
							}
							stroke="white"
							strokeWidth={1.5}
							vectorEffect="non-scaling-stroke"
							className="pointer-events-auto cursor-grab active:cursor-grabbing"
							onPointerDown={(event) => onPointPointerDown(event, index)}
						/>
					);
				})}
			</svg>
		</AbsoluteFill>
	);
};
