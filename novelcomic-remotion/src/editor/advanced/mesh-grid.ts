import type {MeshGrid, MeshPoint} from './types';

export type MeshTriangle = {
	source: [MeshPoint, MeshPoint, MeshPoint];
	destination: [MeshPoint, MeshPoint, MeshPoint];
};

export const createIdentityMeshGrid = (columns = 3, rows = 3): MeshGrid => ({
	columns,
	rows,
	points: Array.from({length: rows}, (_unusedRow, row) =>
		Array.from({length: columns}, (_unusedColumn, column) => ({
			x: column / (columns - 1),
			y: row / (rows - 1),
		})),
	).flat(),
});

const lerp = (from: number, to: number, amount: number): number =>
	from + (to - from) * amount;

const interpolatePoint = (
	from: MeshPoint,
	to: MeshPoint,
	amount: number,
): MeshPoint => ({
	x: lerp(from.x, to.x, amount),
	y: lerp(from.y, to.y, amount),
});

const interpolatePoints = (
	from: readonly MeshPoint[],
	to: readonly MeshPoint[],
	amount: number,
): MeshPoint[] => {
	if (from.length !== to.length) {
		return to.map((point) => ({...point}));
	}

	return from.map((point, index) =>
		interpolatePoint(point, to[index]!, amount),
	);
};

export const isValidMeshGrid = (grid: MeshGrid): boolean => {
	const expectedPointCount = grid.columns * grid.rows;
	return (
		Number.isInteger(grid.columns) &&
		Number.isInteger(grid.rows) &&
		grid.columns >= 2 &&
		grid.rows >= 2 &&
		grid.points.length === expectedPointCount &&
		grid.points.every(
			(point) => Number.isFinite(point.x) && Number.isFinite(point.y),
		) &&
		(grid.keyframes ?? []).every(
			(keyframe) =>
				Number.isInteger(keyframe.frame) &&
				keyframe.frame >= 0 &&
				keyframe.points.length === expectedPointCount,
		)
	);
};

export const evaluateMeshPoints = (
	grid: MeshGrid,
	frame: number,
): MeshPoint[] => {
	if (!isValidMeshGrid(grid)) {
		return [];
	}

	const keyframes = [...(grid.keyframes ?? [])].sort(
		(left, right) => left.frame - right.frame,
	);
	if (keyframes.length === 0) {
		return grid.points.map((point) => ({...point}));
	}

	const before = [...keyframes]
		.reverse()
		.find((keyframe) => keyframe.frame <= frame);
	const after = keyframes.find((keyframe) => keyframe.frame >= frame);
	if (!before && after) return after.points.map((point) => ({...point}));
	if (before && !after) return before.points.map((point) => ({...point}));
	if (!before || !after) return grid.points.map((point) => ({...point}));
	if (before.frame === after.frame) {
		return after.points.map((point) => ({...point}));
	}

	const amount = (frame - before.frame) / (after.frame - before.frame);
	return interpolatePoints(before.points, after.points, amount);
};

export const meshGridToTriangles = (
	grid: MeshGrid,
	width: number,
	height: number,
	frame = 0,
): MeshTriangle[] => {
	const destinationPoints = evaluateMeshPoints(grid, frame);
	if (
		destinationPoints.length !== grid.columns * grid.rows ||
		width <= 0 ||
		height <= 0
	) {
		return [];
	}

	const sourcePoints = Array.from({length: grid.rows}, (_unusedRow, row) =>
		Array.from({length: grid.columns}, (_unusedColumn, column) => ({
			x: column / (grid.columns - 1),
			y: row / (grid.rows - 1),
		})),
	).flat();
	const triangles: MeshTriangle[] = [];

	for (let row = 0; row < grid.rows - 1; row++) {
		for (let column = 0; column < grid.columns - 1; column++) {
			const topLeft = row * grid.columns + column;
			const topRight = topLeft + 1;
			const bottomLeft = topLeft + grid.columns;
			const bottomRight = bottomLeft + 1;
			const source = [
				sourcePoints[topLeft]!,
				sourcePoints[topRight]!,
				sourcePoints[bottomLeft]!,
			].map((point) => ({x: point.x * width, y: point.y * height})) as [
				MeshPoint,
				MeshPoint,
				MeshPoint,
			];
			const sourceSecond = [
				sourcePoints[topRight]!,
				sourcePoints[bottomRight]!,
				sourcePoints[bottomLeft]!,
			].map((point) => ({x: point.x * width, y: point.y * height})) as [
				MeshPoint,
				MeshPoint,
				MeshPoint,
			];
			const destination = [
				destinationPoints[topLeft]!,
				destinationPoints[topRight]!,
				destinationPoints[bottomLeft]!,
			].map((point) => ({x: point.x * width, y: point.y * height})) as [
				MeshPoint,
				MeshPoint,
				MeshPoint,
			];
			const destinationSecond = [
				destinationPoints[topRight]!,
				destinationPoints[bottomRight]!,
				destinationPoints[bottomLeft]!,
			].map((point) => ({x: point.x * width, y: point.y * height})) as [
				MeshPoint,
				MeshPoint,
				MeshPoint,
			];
			triangles.push(
				{source, destination},
				{source: sourceSecond, destination: destinationSecond},
			);
		}
	}

	return triangles;
};

export const affineMatrixForTriangle = (
	source: [MeshPoint, MeshPoint, MeshPoint],
	destination: [MeshPoint, MeshPoint, MeshPoint],
): [number, number, number, number, number, number] | null => {
	const [s0, s1, s2] = source;
	const [d0, d1, d2] = destination;
	const determinant =
		s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
	if (Math.abs(determinant) < 0.000001) return null;

	const coefficient = (v0: number, v1: number, v2: number) => ({
		a:
			(v0 * (s1.y - s2.y) + v1 * (s2.y - s0.y) + v2 * (s0.y - s1.y)) /
			determinant,
		c:
			(v0 * (s2.x - s1.x) + v1 * (s0.x - s2.x) + v2 * (s1.x - s0.x)) /
			determinant,
		e:
			(v0 * (s1.x * s2.y - s2.x * s1.y) +
				v1 * (s2.x * s0.y - s0.x * s2.y) +
				v2 * (s0.x * s1.y - s1.x * s0.y)) /
			determinant,
	});
	const x = coefficient(d0.x, d1.x, d2.x);
	const y = coefficient(d0.y, d1.y, d2.y);
	return [x.a, y.a, x.c, y.c, x.e, y.e];
};
