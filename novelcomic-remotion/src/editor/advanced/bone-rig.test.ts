import {describe, expect, it} from 'vitest';
import {evaluateBoneRig, rootBoneCssTransform} from './bone-rig';

describe('bone rig', () => {
	it('interpolates root keyframes and composes child world transforms', () => {
		const rig = {
			rootBoneId: 'root',
			bones: [
				{
					id: 'root',
					name: 'Root',
					x: 10,
					y: 20,
					length: 20,
					rotation: 0,
					scaleX: 1,
					scaleY: 1,
					keyframes: [{frame: 10, x: 30, y: 40, rotation: 90}],
				},
				{
					id: 'child',
					name: 'Child',
					parentId: 'root',
					x: 10,
					y: 0,
					length: 10,
					rotation: 0,
					scaleX: 1,
					scaleY: 1,
				},
			],
		};
		const evaluated = evaluateBoneRig(rig, 10);
		expect(evaluated[0]).toMatchObject({worldX: 30, worldY: 40});
		expect(evaluated[1]).toMatchObject({worldX: 30, worldY: 50});
		expect(rootBoneCssTransform(rig, 10)).toContain('translate(30px, 40px)');
	});
});
