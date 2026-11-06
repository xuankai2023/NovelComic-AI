import {describe, expect, it} from 'vitest';
import {PixelEditSession} from './pixel-edit-session';
import {createPixelBuffer} from './pixel-tools';

describe('PixelEditSession', () => {
	it('supports preview, cancel and apply as a single transaction', () => {
		const source = createPixelBuffer(1, 1, [1, 2, 3, 255]);
		const session = new PixelEditSession(source);
		session.preview(createPixelBuffer(1, 1, [9, 9, 9, 255]));
		expect(session.cancel().data[0]).toBe(1);
		const applied = new PixelEditSession(source);
		applied.preview(createPixelBuffer(1, 1, [8, 8, 8, 255]));
		expect(applied.apply().data[0]).toBe(8);
	});
});
