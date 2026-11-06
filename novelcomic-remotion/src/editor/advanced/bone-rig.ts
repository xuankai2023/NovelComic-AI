import type {Bone, BoneKeyframe, BoneRig} from './types';

export type EvaluatedBone = Bone & {
	worldX: number;
	worldY: number;
	worldRotation: number;
	worldScaleX: number;
	worldScaleY: number;
};

const interpolate = (
	keyframes: readonly BoneKeyframe[] | undefined,
	frame: number,
	field: keyof Omit<BoneKeyframe, 'frame'>,
	fallback: number,
) => {
	if (!keyframes || keyframes.length === 0) {
		return fallback;
	}
	const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
	const before = [...sorted].reverse().find((entry) => entry.frame <= frame);
	const after = sorted.find((entry) => entry.frame >= frame);
	if (!before && after) return after[field] ?? fallback;
	if (before && !after) return before[field] ?? fallback;
	if (!before || !after) return fallback;
	if (before.frame === after.frame) return before[field] ?? fallback;
	const t = (frame - before.frame) / (after.frame - before.frame);
	return (
		(before[field] ?? fallback) +
		((after[field] ?? fallback) - (before[field] ?? fallback)) * t
	);
};

export const evaluateBoneRig = (
	rig: BoneRig,
	frame: number,
): EvaluatedBone[] => {
	const byId = new Map(rig.bones.map((bone) => [bone.id, bone]));
	const result = new Map<string, EvaluatedBone>();

	const visit = (bone: Bone): EvaluatedBone => {
		const cached = result.get(bone.id);
		if (cached) return cached;

		const localRotation = interpolate(
			bone.keyframes,
			frame,
			'rotation',
			bone.rotation,
		);
		const localX = interpolate(bone.keyframes, frame, 'x', bone.x);
		const localY = interpolate(bone.keyframes, frame, 'y', bone.y);
		const localScaleX = interpolate(
			bone.keyframes,
			frame,
			'scaleX',
			bone.scaleX,
		);
		const localScaleY = interpolate(
			bone.keyframes,
			frame,
			'scaleY',
			bone.scaleY,
		);
		const parent = bone.parentId ? byId.get(bone.parentId) : undefined;

		if (!parent) {
			const evaluated = {
				...bone,
				worldX: localX,
				worldY: localY,
				worldRotation: localRotation,
				worldScaleX: localScaleX,
				worldScaleY: localScaleY,
			};
			result.set(bone.id, evaluated);
			return evaluated;
		}

		const evaluatedParent = visit(parent);
		const radians = (evaluatedParent.worldRotation * Math.PI) / 180;
		const scaledX = localX * evaluatedParent.worldScaleX;
		const scaledY = localY * evaluatedParent.worldScaleY;
		const evaluated = {
			...bone,
			worldX:
				evaluatedParent.worldX +
				scaledX * Math.cos(radians) -
				scaledY * Math.sin(radians),
			worldY:
				evaluatedParent.worldY +
				scaledX * Math.sin(radians) +
				scaledY * Math.cos(radians),
			worldRotation: evaluatedParent.worldRotation + localRotation,
			worldScaleX: evaluatedParent.worldScaleX * localScaleX,
			worldScaleY: evaluatedParent.worldScaleY * localScaleY,
		};
		result.set(bone.id, evaluated);
		return evaluated;
	};

	for (const bone of rig.bones) {
		visit(bone);
	}

	return rig.bones.map((bone) => result.get(bone.id) as EvaluatedBone);
};

export const rootBoneCssTransform = (
	rig: BoneRig | undefined,
	frame: number,
): string | undefined => {
	if (!rig) return undefined;
	const root = evaluateBoneRig(rig, frame).find(
		(bone) => bone.id === rig.rootBoneId,
	);
	if (!root) return undefined;
	return `translate(${root.worldX}px, ${root.worldY}px) rotate(${root.worldRotation}deg) scale(${root.worldScaleX}, ${root.worldScaleY})`;
};
