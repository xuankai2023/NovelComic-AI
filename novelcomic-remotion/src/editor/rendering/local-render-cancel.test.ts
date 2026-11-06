import {afterEach, describe, expect, it, vi} from 'vitest';
import type {RenderVideoPayload} from './types';

const renderMediaLocal = vi.hoisted(() => vi.fn());

vi.mock('./render-media-local', () => ({renderMediaLocal}));

import {
	beginLocalRender,
	cancelLocalRender,
	localProgressResponse,
} from './local-render-jobs';

afterEach(() => {
	renderMediaLocal.mockReset();
});

describe('local RenderJob cancellation', () => {
	it('cancels the renderer signal and exposes canceled terminal state', async () => {
		renderMediaLocal.mockImplementation(
			({cancelSignal}: {cancelSignal?: (callback: () => void) => void}) =>
				new Promise((_, reject) => {
					cancelSignal?.(() => reject(new Error('Render canceled')));
				}),
		);
		const handle = beginLocalRender({} as RenderVideoPayload);

		expect(await cancelLocalRender(handle.renderId)).toEqual({
			type: 'canceled',
		});
		await vi.waitFor(() => {
			expect(localProgressResponse(handle.renderId)).toEqual({
				type: 'canceled',
			});
		});
		expect(renderMediaLocal).toHaveBeenCalledWith(
			expect.objectContaining({cancelSignal: expect.any(Function)}),
		);
	});
});
