import {applyCameraRaw} from './camera-raw';
import {applyGradient, boxBlur, cloneStamp, contentAwareFill, eraseBrush, magicWandSelection, paintBrush, removeBackground, smudgePixels, spotHealing, type BrushOptions, type GradientOptions, type PixelBuffer, type PixelPoint, type PixelSelection} from './pixel-tools';

export type PixelWorkerOperation =
	| {kind: 'brush'; source: PixelBuffer; points: PixelPoint[]; options: BrushOptions}
	| {kind: 'erase'; source: PixelBuffer; points: PixelPoint[]; options: Omit<BrushOptions, 'color'>}
	| {kind: 'blur'; source: PixelBuffer; radius: number; selection?: PixelSelection}
	| {kind: 'smudge'; source: PixelBuffer; points: PixelPoint[]; options: BrushOptions & {strength?: number; mode?: 'smudge' | 'liquify'}}
	| {kind: 'clone'; source: PixelBuffer; sourcePoint: PixelPoint; points: PixelPoint[]; options: BrushOptions & {aligned?: boolean}}
	| {kind: 'heal'; source: PixelBuffer; points: PixelPoint[]; options: BrushOptions}
	| {kind: 'gradient'; source: PixelBuffer; options: GradientOptions; selection?: PixelSelection}
	| {kind: 'camera-raw'; source: PixelBuffer; settings: Parameters<typeof applyCameraRaw>[1]}
	| {kind: 'fill'; source: PixelBuffer; selection: PixelSelection}
	| {kind: 'remove-background'; source: PixelBuffer; subject: PixelSelection}
	| {kind: 'magic-wand'; source: PixelBuffer; point: PixelPoint; tolerance?: number};

export type PixelWorkerResult = PixelBuffer | PixelSelection;
export const runPixelOperation = (operation: PixelWorkerOperation): PixelWorkerResult => {
	switch (operation.kind) {
		case 'brush': return paintBrush(operation.source, operation.points, operation.options);
		case 'erase': return eraseBrush(operation.source, operation.points, operation.options);
		case 'blur': return boxBlur(operation.source, operation.radius, operation.selection);
		case 'smudge': return smudgePixels(operation.source, operation.points, operation.options);
		case 'clone': return cloneStamp(operation.source, operation.sourcePoint, operation.points, operation.options);
		case 'heal': return spotHealing(operation.source, operation.points, operation.options);
		case 'gradient': return applyGradient(operation.source, operation.options, operation.selection);
		case 'camera-raw': return applyCameraRaw(operation.source, operation.settings);
		case 'fill': return contentAwareFill(operation.source, operation.selection);
		case 'remove-background': return removeBackground(operation.source, operation.subject);
		case 'magic-wand': return magicWandSelection(operation.source, operation.point, operation.tolerance);
	}
};
