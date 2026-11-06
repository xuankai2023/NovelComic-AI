import {describe, expect, it} from 'vitest';
import {PANEL_BLUR_RADIUS_PX, PANEL_DIM_OPACITY} from '../../comic/panel-fit';
import {panelImageStyle} from './image-fit-style';

describe('panelImageStyle', () => {
	it('blurs and dims from the item fields', () => {
		expect(
			panelImageStyle({
				blurRadiusPx: PANEL_BLUR_RADIUS_PX,
				dimOpacity: PANEL_DIM_OPACITY,
			}),
		).toEqual({
			image: {filter: 'blur(28px)'},
			dimOpacity: 0.45,
		});
	});

	it('leaves a plain contain item unchanged', () => {
		expect(panelImageStyle({})).toEqual({
			image: {},
			dimOpacity: undefined,
		});
	});

	it('writes blend mode and alpha mask styles', () => {
		expect(
			panelImageStyle({
				blendMode: 'multiply',
				maskUrl: 'https://cdn.example.com/mask.png',
				maskMode: 'alpha',
			}),
		).toEqual({
			image: {
				mixBlendMode: 'multiply',
				maskImage: 'url("https://cdn.example.com/mask.png")',
				maskSize: '100% 100%',
				maskPosition: '0 0',
				maskRepeat: 'no-repeat',
				maskMode: 'alpha',
			},
			dimOpacity: undefined,
		});
	});

	it('uses a subtractive mask for inverse alpha mode', () => {
		expect(
			panelImageStyle({
				maskUrl: 'mask.png',
				maskMode: 'inverse-alpha',
			}).image,
		).toMatchObject({
			maskImage: 'linear-gradient(#fff, #fff), url("mask.png")',
			maskComposite: 'exclude',
			WebkitMaskComposite: 'xor',
		});
	});
});
