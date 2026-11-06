import {describe, expect, it, vi} from 'vitest';
import {appendImageSequence, panelIds} from '../comic/append-image-sequence';
import {createComicProject} from '../compose/build-state';
import type {ImageItem} from '../items/image/image-item-type';
import {renderMediaLocal} from './render-media-local';
import {renderPreviewFrame} from './render-preview-frame';
import {submitRender} from './submit-render';
import {toCompositionProps} from './to-composition-props';
import type {RenderVideoPayload} from './types';
import {validateRenderPayload} from './validate-render-payload';

const invalidProject = () => {
	const project = appendImageSequence(createComicProject(), {
		allowedHosts: ['cdn.example.com'],
		images: [
			{
				shotId: 'shot-1',
				url: 'https://cdn.example.com/image.png',
				width: 1080,
				height: 1920,
				durationInFrames: 30,
			},
		],
	});
	const item = project.items[panelIds('shot-1').itemId] as ImageItem;
	item.motion = {
		transform: {
			keyframes: [
				{frame: 0, scaleX: 1},
				{frame: 0, scaleX: Number.NaN},
			],
		},
	};
	return project;
};

const payloadFor = (): RenderVideoPayload => ({
	...toCompositionProps(invalidProject()),
	codec: 'h264',
});

describe('render Transform validation', () => {
	it('uses the same diagnostic before payload, preview, local, and remote submission', async () => {
		const payload = payloadFor();
		expect(() => validateRenderPayload(payload)).toThrow(/Item .*frame 0/);

		const submitPreview = vi.fn(async () => ({taskId: 'should-not-submit'}));
		await expect(
			renderPreviewFrame({
				project: invalidProject(),
				frame: 0,
				submit: submitPreview,
			}),
		).rejects.toMatchObject({code: 'DOMAIN_INVARIANT'});
		expect(submitPreview).not.toHaveBeenCalled();

		await expect(
			renderMediaLocal({renderId: 'invalid-local', payload}),
		).rejects.toThrow(/Item .*frame 0/);
		await expect(submitRender(payload)).rejects.toThrow(/Item .*frame 0/);
	});
});
