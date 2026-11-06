import type {DocumentState, Guide} from './types';
import {getLayerBounds, type DocumentBounds} from './transform';

export type SnapAxis = 'x' | 'y';
export type SnapTarget = {axis: SnapAxis; position: number; kind: 'canvas-edge' | 'canvas-center' | 'guide' | 'layer-edge' | 'layer-center'; sourceId?: string};
export type SnapPoint = {axis: SnapAxis; edge: 'start' | 'center' | 'end'; position: number; target: SnapTarget; distance: number};
export type DocumentSnapResult = {dx: number; dy: number; points: SnapPoint[]};
export type SnapOptions = {enabled?: boolean; thresholdPx?: number; zoom?: number; gridSize?: number; includeLayers?: boolean};

const edges = (bounds: DocumentBounds, axis: SnapAxis) => axis === 'x' ? [{edge: 'start' as const, position: bounds.left}, {edge: 'center' as const, position: bounds.centerX}, {edge: 'end' as const, position: bounds.right}] : [{edge: 'start' as const, position: bounds.top}, {edge: 'center' as const, position: bounds.centerY}, {edge: 'end' as const, position: bounds.bottom}];
const canvasTargets = (width: number, height: number): SnapTarget[] => [{axis: 'x', position: 0, kind: 'canvas-edge'}, {axis: 'x', position: width / 2, kind: 'canvas-center'}, {axis: 'x', position: width, kind: 'canvas-edge'}, {axis: 'y', position: 0, kind: 'canvas-edge'}, {axis: 'y', position: height / 2, kind: 'canvas-center'}, {axis: 'y', position: height, kind: 'canvas-edge'}];
const guideTargets = (guides: readonly Guide[]): SnapTarget[] => guides.map((guide) => ({axis: guide.orientation === 'horizontal' ? 'y' : 'x', position: guide.position, kind: 'guide' as const, sourceId: guide.id}));

export const getDocumentSnapTargets = (document: DocumentState, excludedLayerIds: readonly string[] = [], options: SnapOptions = {}): SnapTarget[] => {
	const targets = [...canvasTargets(document.width, document.height), ...guideTargets(document.guides)];
	if (options.gridSize && options.gridSize > 0) for (let p = options.gridSize; p < document.width; p += options.gridSize) targets.push({axis: 'x', position: p, kind: 'guide'});
	if (options.gridSize && options.gridSize > 0) for (let p = options.gridSize; p < document.height; p += options.gridSize) targets.push({axis: 'y', position: p, kind: 'guide'});
	if (options.includeLayers !== false) for (const layer of Object.values(document.layers)) if (!excludedLayerIds.includes(layer.id) && layer.visible) { const bounds = getLayerBounds(document, layer.id); if (!bounds) continue; targets.push({axis: 'x', position: bounds.left, kind: 'layer-edge', sourceId: layer.id}, {axis: 'x', position: bounds.centerX, kind: 'layer-center', sourceId: layer.id}, {axis: 'x', position: bounds.right, kind: 'layer-edge', sourceId: layer.id}, {axis: 'y', position: bounds.top, kind: 'layer-edge', sourceId: layer.id}, {axis: 'y', position: bounds.centerY, kind: 'layer-center', sourceId: layer.id}, {axis: 'y', position: bounds.bottom, kind: 'layer-edge', sourceId: layer.id}); }
	return targets;
};

export const snapBounds = (bounds: DocumentBounds, targets: readonly SnapTarget[], options: SnapOptions = {}): DocumentSnapResult => {
	if (options.enabled === false) return {dx: 0, dy: 0, points: []};
	const threshold = (options.thresholdPx ?? 8) / Math.max(options.zoom ?? 1, 0.0001);
	const points: SnapPoint[] = [];
	for (const axis of ['x', 'y'] as const) {
		let best: SnapPoint | undefined;
		for (const edge of edges(bounds, axis)) for (const target of targets) {
			if (target.axis !== axis) continue;
			const distance = Math.abs(edge.position - target.position);
			if (distance <= threshold && (!best || distance < best.distance)) best = {...edge, axis, target, distance};
		}
		if (best) points.push(best);
	}
	return {dx: points.find((point) => point.axis === 'x') ? points.find((point) => point.axis === 'x')!.target.position - points.find((point) => point.axis === 'x')!.position : 0, dy: points.find((point) => point.axis === 'y') ? points.find((point) => point.axis === 'y')!.target.position - points.find((point) => point.axis === 'y')!.position : 0, points};
};
