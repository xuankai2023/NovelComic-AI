import type {CSSProperties} from 'react';
import React, {useId, useMemo} from 'react';
import {Img} from 'remotion';
import {
	affineMatrixForTriangle,
	meshGridToTriangles,
} from '../../advanced/mesh-grid';
import type {MeshGrid} from '../../advanced/types';

const formatMatrix = (
	matrix: [number, number, number, number, number, number],
): string =>
	`matrix(${matrix.map((value) => Number(value.toFixed(6))).join(',')})`;

export const MeshWarpImage: React.FC<{
	src: string;
	width: number;
	height: number;
	grid: MeshGrid;
	frame: number;
	style?: CSSProperties;
}> = ({src, width, height, grid, frame, style}) => {
	const rawId = useId();
	const clipId = `mesh-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
	const triangles = useMemo(
		() => meshGridToTriangles(grid, width, height, frame),
		[frame, grid, height, width],
	);

	if (triangles.length === 0) {
		return (
			<Img crossOrigin="anonymous" pauseWhenLoading style={style} src={src} />
		);
	}

	return (
		<svg
			viewBox={`0 0 ${width} ${height}`}
			width={width}
			height={height}
			style={style}
			preserveAspectRatio="none"
			aria-hidden
		>
			<defs>
				{triangles.map((triangle, index) => (
					<clipPath
						key={`${clipId}-clip-${index}`}
						id={`${clipId}-clip-${index}`}
						clipPathUnits="userSpaceOnUse"
					>
						<polygon
							points={triangle.destination
								.map((point) => `${point.x},${point.y}`)
								.join(' ')}
						/>
					</clipPath>
				))}
			</defs>
			{triangles.map((triangle, index) => {
				const matrix = affineMatrixForTriangle(
					triangle.source,
					triangle.destination,
				);
				if (!matrix) return null;

				return (
					<g
						key={`${clipId}-triangle-${index}`}
						clipPath={`url(#${clipId}-clip-${index})`}
					>
						<image
							href={src}
							x={0}
							y={0}
							width={width}
							height={height}
							preserveAspectRatio="none"
							transform={formatMatrix(matrix)}
							crossOrigin="anonymous"
						/>
					</g>
				);
			})}
		</svg>
	);
};
