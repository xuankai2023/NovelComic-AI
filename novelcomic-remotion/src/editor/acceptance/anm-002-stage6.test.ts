import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import type {ImageItem} from '../items/image/image-item-type';
import {validateTransformAnimation} from '../motion/diagnostics';
import {
	clearTransformEvaluationCache,
	evaluateImagePose,
	evaluateTransformAtFrame,
} from '../motion/evaluate';
import type {TransformAnimation} from '../motion/types';
import {renderMediaLocal} from '../rendering/render-media-local';
import {renderPreviewFrame} from '../rendering/render-preview-frame';
import {submitRender} from '../rendering/submit-render';
import {toCompositionProps} from '../rendering/to-composition-props';
import type {RenderVideoPayload} from '../rendering/types';
import {validateRenderPayload} from '../rendering/validate-render-payload';
import {restoreItemsAfterCancelledDrag} from '../state/actions/cancel-item-drag';
import {updateTransformPropertyInState} from '../state/actions/update-transform-property';
import {cleanUpStateBeforeSaving} from '../state/clean-up-state-before-saving';
import {getInitialState} from '../state/initial-state';
import {normalizeUndoableState} from '../state/normalize-undoable-state';
import type {UndoableState} from '../state/types';

const imageItem = (motion?: ImageItem['motion']): ImageItem => ({
	id: 'anm-002-image',
	type: 'image',
	assetId: 'anm-002-asset',
	durationInFrames: 40,
	from: 0,
	top: 0,
	left: 0,
	width: 200,
	height: 100,
	opacity: 1,
	isDraggingInTimeline: false,
	borderRadius: 0,
	rotation: 0,
	keepAspectRatio: true,
	fadeInDurationInSeconds: 0,
	fadeOutDurationInSeconds: 0,
	cropLeft: 0,
	cropTop: 0,
	cropRight: 0,
	cropBottom: 0,
	motion,
});

const projectWith = (item: ImageItem): UndoableState => ({
	...getInitialState().undoableState,
	fps: 30,
	compositionWidth: 200,
	compositionHeight: 100,
	items: {[item.id]: item},
	assets: {
		[item.assetId]: {
			id: item.assetId,
			type: 'image',
			filename: 'anm-002.png',
			size: 1,
			remoteUrl: 'https://cdn.example.com/anm-002.png',
			remoteFileKey: null,
			mimeType: 'image/png',
			width: 200,
			height: 100,
		},
	},
	tracks: [
		{id: 'anm-002-track', items: [item.id], hidden: false, muted: false},
	],
});

const payloadFor = (project: UndoableState): RenderVideoPayload => ({
	...toCompositionProps(project),
	codec: 'h264',
});

describe('ANM-002 stage 6 acceptance', () => {
	it('round-trips static and sparse multi-property Transform data without creating a second owner', () => {
		const transform: TransformAnimation = {
			x: 12,
			y: -4,
			scaleX: 1.2,
			scaleY: 0.8,
			rotation: 18,
			opacity: 0.7,
			anchorX: 0.25,
			anchorY: 0.75,
			animatedProperties: ['position', 'rotation', 'opacity'],
			loop: 'ping-pong',
			loopStartFrame: 4,
			loopEndFrame: 24,
			keyframes: [
				{
					frame: 4,
					x: 10,
					y: 20,
					easing: 'ease-in',
					hold: true,
					handleOut: {x: 0.2, y: 0.8},
				},
				{
					frame: 18,
					rotation: 45,
					opacity: 0.4,
					easing: 'ease-out',
					handleIn: {x: 0.8, y: 0.2},
				},
			],
		};
		const source = projectWith(imageItem({transform}));
		const saved = cleanUpStateBeforeSaving(source);
		const reloaded = normalizeUndoableState(
			JSON.parse(JSON.stringify(saved)) as UndoableState,
		);
		const reloadedTransform = reloaded.items[imageItem().id];

		expect(reloadedTransform).toBeDefined();
		expect(reloadedTransform).toEqual(source.items[imageItem().id]);
		expect(
			reloadedTransform?.type === 'image' &&
				reloadedTransform.motion?.transform,
		).toEqual(transform);
		expect(JSON.stringify(reloaded)).not.toContain('transform2');
	});

	it('does not clean invalid Transform data and keeps the same diagnostic after reload', () => {
		const transform = {
			animatedProperties: ['position'],
			loop: 'repeat',
			loopStartFrame: 30,
			loopEndFrame: 10,
			keyframes: [
				{frame: 2, x: 10},
				{frame: 2, y: 20},
			],
		} as unknown as TransformAnimation;
		const source = projectWith(imageItem({transform}));
		const before = validateTransformAnimation({
			animation: transform,
			itemId: 'anm-002-image',
			durationInFrames: 40,
		});
		const reloaded = normalizeUndoableState(
			JSON.parse(
				JSON.stringify(cleanUpStateBeforeSaving(source)),
			) as UndoableState,
		);
		const afterTransform = reloaded.items['anm-002-image'];
		const after = validateTransformAnimation({
			animation:
				afterTransform?.type === 'image'
					? afterTransform.motion?.transform
					: undefined,
			itemId: 'anm-002-image',
			durationInFrames: 40,
		});
		expect(after).toEqual(before);
		expect(
			afterTransform?.type === 'image' &&
				afterTransform.motion?.transform?.keyframes,
		).toHaveLength(2);
	});

	it('uses the latest state for writes and keeps evaluator results finite across cache boundaries', () => {
		const first = projectWith(
			imageItem({
				transform: {
					animatedProperties: ['position'],
					keyframes: [
						{frame: 0, x: 0, y: 0},
						{frame: 20, x: 20, y: 20},
					],
				},
			}),
		);
		const editor = {...getInitialState(), undoableState: first};
		const write = updateTransformPropertyInState({
			state: editor,
			itemId: 'anm-002-image',
			globalFrame: 10,
			property: 'position',
			values: [100, 80],
			mode: 'write',
			autoKeyEnabled: true,
		});
		expect(write.status).toBe('updated');
		const updated = write.state.undoableState.items['anm-002-image'];
		expect(
			updated?.type === 'image' &&
				evaluateTransformAtFrame(updated.motion?.transform, 10),
		).toMatchObject({x: 100, y: 80});

		const animation =
			updated?.type === 'image' ? updated.motion?.transform : undefined;
		clearTransformEvaluationCache();
		const bounded = evaluateTransformAtFrame(animation, 100, {
			durationInFrames: 40,
		});
		const unbounded = evaluateTransformAtFrame(animation, 100);
		expect(Object.values(bounded).every(Number.isFinite)).toBe(true);
		expect(Object.values(unbounded).every(Number.isFinite)).toBe(true);
		clearTransformEvaluationCache();
		expect(evaluateTransformAtFrame(animation, 10)).toEqual(
			evaluateTransformAtFrame(animation, 10),
		);
	});

	it('keeps editor pose and render props on the same evaluator result', () => {
		const item = imageItem({
			transform: {
				animatedProperties: [
					'anchorPoint',
					'position',
					'scale',
					'rotation',
					'opacity',
				],
				keyframes: [
					{
						frame: 0,
						anchorX: 0.2,
						anchorY: 0.8,
						x: 10,
						y: 12,
						scaleX: 1,
						scaleY: 1,
						rotation: 0,
						opacity: 1,
					},
					{
						frame: 20,
						anchorX: 0.6,
						anchorY: 0.4,
						x: 50,
						y: 32,
						scaleX: 1.4,
						scaleY: 0.7,
						rotation: 35,
						opacity: 0.5,
						easing: 'ease-in-out',
						hold: false,
					},
				],
			},
		});
		const project = projectWith(item);
		const frame = 10;
		const evaluated = evaluateTransformAtFrame(item.motion?.transform, frame, {
			durationInFrames: item.durationInFrames,
		});
		const pose = evaluateImagePose({
			item,
			shot: null,
			globalFrame: frame,
			compositionWidth: project.compositionWidth,
			compositionHeight: project.compositionHeight,
			fadeOpacity: 1,
		});
		const rendered = toCompositionProps(project).items[item.id];
		expect(rendered?.type).toBe('image');
		expect(pose.rotation).toBeCloseTo(item.rotation + evaluated.rotation);
		expect(pose.opacity).toBeCloseTo(evaluated.opacity);
		expect(pose.anchorX).toBeCloseTo(evaluated.anchorX);
		expect(rendered?.type).toBe('image');
		if (rendered?.type === 'image') {
			expect(rendered.motion?.transform).toEqual(item.motion?.transform);
		}
	});

	it('rejects invalid Transform before preview, local, and remote submission without leaking request details', async () => {
		const item = imageItem({
			transform: {keyframes: [{frame: 0, scaleX: Number.NaN}]},
		});
		const payload = payloadFor(projectWith(item));
		expect(() => validateRenderPayload(payload)).toThrow(
			/Item anm-002-image.*frame 0/,
		);
		const previewSubmit = vi.fn(async () => ({taskId: 'must-not-run'}));
		await expect(
			renderPreviewFrame({
				project: projectWith(item),
				frame: 0,
				submit: previewSubmit,
			}),
		).rejects.toThrow(/Item anm-002-image.*frame 0/);
		expect(previewSubmit).not.toHaveBeenCalled();
		await expect(
			renderMediaLocal({renderId: 'anm-002-invalid', payload}),
		).rejects.toThrow(/Item anm-002-image.*frame 0/);
		await expect(submitRender(payload)).rejects.toThrow(
			/Item anm-002-image.*frame 0/,
		);
		await expect(submitRender(payload)).rejects.not.toThrow(
			/https?:\/\/|Authorization|stack|request body/i,
		);
	});

	it('preserves the Undo boundary for continuous Viewer drags and cancels safely', () => {
		const source = [
			'src/editor/timeline/property-timeline/transform-property-keyframes.tsx',
			'src/editor/canvas/canvas.tsx',
		]
			.map((file) => readFileSync(path.join(process.cwd(), file), 'utf8'))
			.join('\n');
		expect(source).toContain('commitToUndoStack: false');
		expect(source).toContain('commitToUndoStack: true');
		expect(source).toContain("keyEvent.key === 'Escape'");
		expect(source).toContain("window.addEventListener('pointercancel'");

		const snapshot = imageItem({transform: {keyframes: []}});
		const editor = {
			...getInitialState(),
			undoableState: projectWith({
				...snapshot,
				motion: {transform: {x: 8, keyframes: []}},
			}),
		};
		const cancelled = restoreItemsAfterCancelledDrag({
			state: editor,
			snapshots: [snapshot],
		});
		expect(cancelled.undoableState.items[snapshot.id]).toBe(snapshot);

		const deleted = {
			...editor,
			undoableState: {...editor.undoableState, items: {}},
		};
		expect(
			restoreItemsAfterCancelledDrag({state: deleted, snapshots: [snapshot]}),
		).toBe(deleted);
	});
});
