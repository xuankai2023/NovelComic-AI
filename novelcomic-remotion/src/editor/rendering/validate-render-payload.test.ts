import {describe, expect, it} from 'vitest';
import type {ImageAsset} from '../assets/assets';
import type {ImageItem} from '../items/image/image-item-type';
import type {RenderVideoPayload} from './types';
import {validateRenderPayload} from './validate-render-payload';

const frames = (seconds: number): number => seconds * 30;

const imageAsset = (id: string): ImageAsset => {
	return {
		id,
		type: 'image',
		filename: `${id}.png`,
		size: 1,
		remoteUrl: `https://cdn.example.com/${id}.png`,
		remoteFileKey: null,
		mimeType: 'image/png',
		width: 100,
		height: 100,
	};
};

const imageItem = (durationInFrames: number): ImageItem => {
	return {
		id: 'image-1',
		type: 'image',
		assetId: 'asset-main',
		durationInFrames,
		from: 0,
		top: 0,
		left: 0,
		width: 100,
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
	};
};

const payload = (
	durationInFrames: number,
	extra: Partial<RenderVideoPayload> = {},
): RenderVideoPayload => {
	const item = imageItem(durationInFrames);
	return {
		compositionWidth: 1080,
		compositionHeight: 1920,
		fps: 30,
		tracks: [
			{
				id: 'track-1',
				items: [item.id],
				hidden: false,
				muted: false,
			},
		],
		items: {[item.id]: item},
		assets: {'asset-main': imageAsset('asset-main')},
		...extra,
	};
};

describe('validateRenderPayload frameRange', () => {
	it('rejects invalid Transform data before any render submission', () => {
		const invalid = imageItem(30);
		invalid.motion = {
			transform: {
				keyframes: [{frame: 0, scaleX: 0}, {frame: 0, opacity: 2}],
			},
		};
		expect(() =>
			validateRenderPayload(
				payload(30, {items: {[invalid.id]: invalid}}),
			),
		).toThrow(/invalid|non-positive|duplicate/i);
	});

	it('counts both endpoints and accepts 5 and 18 second batches', () => {
		const five = validateRenderPayload(
			payload(frames(20), {
				frameRange: [0, frames(5) - 1],
				enforceBatchDuration: true,
			}),
		);
		expect(five.frameRange).toEqual([0, 149]);
		expect(five.enforceBatchDuration).toBe(true);

		const eighteen = validateRenderPayload(
			payload(frames(20), {
				frameRange: [10, 10 + frames(18) - 1],
				enforceBatchDuration: true,
			}),
		);
		expect(eighteen.frameRange).toEqual([10, 549]);

		expect(() =>
			validateRenderPayload(
				payload(frames(20), {
					frameRange: [0, frames(5) - 2],
					enforceBatchDuration: true,
				}),
			),
		).toThrow(/between 5 and 18 seconds/);
		expect(() =>
			validateRenderPayload(
				payload(frames(20), {
					frameRange: [0, frames(18)],
					enforceBatchDuration: true,
				}),
			),
		).toThrow(/between 5 and 18 seconds/);
	});

	it('rejects negative, reversed, and out-of-range frames', () => {
		expect(() =>
			validateRenderPayload(payload(300, {frameRange: [-1, 10]})),
		).toThrow(/negative/);
		expect(() =>
			validateRenderPayload(payload(300, {frameRange: [10, 5]})),
		).toThrow(/must not precede start/);
		expect(() =>
			validateRenderPayload(payload(300, {frameRange: [0, 300]})),
		).toThrow(/outside the project/);
		expect(
			validateRenderPayload(payload(300, {frameRange: [0, 299]})).frameRange,
		).toEqual([0, 299]);
	});

	it('keeps a full export valid when frameRange is omitted', () => {
		const parsed = validateRenderPayload(payload(90));
		expect(parsed.frameRange).toBeUndefined();
		expect(parsed.enforceBatchDuration).toBeUndefined();
	});
});
