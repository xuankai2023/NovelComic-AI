import type {SpriteState} from '../motion/types';
import {domainInvariant} from './errors';
import {COMIC_DEFAULT_FPS} from './limits';

export const MAX_SPRITE_SWITCHES_PER_SECOND = 8;

export type BlinkSpriteInput = {
	openAssetId: string;
	closedAssetId: string;
	seed: number;
	durationInFrames: number;
	fps?: number;
};

export type MouthFlapSpriteInput = {
	assetIds: {
		closed: string;
		half?: string;
		open: string;
	};
	dialogueRanges: Array<{
		from: number;
		durationInFrames: number;
	}>;
	phonemeCues?: PhonemeMouthCue[];
	durationInFrames: number;
	fps?: number;
};

export const MOUTH_SHAPES = ['closed', 'half', 'open'] as const;

export type MouthShape = (typeof MOUTH_SHAPES)[number];

export type PhonemeMouthCue = {
	from: number;
	durationInFrames: number;
	mouthShape?: MouthShape;
	phoneme?: string;
};

const unitFromSeed = (seed: number): number => {
	const normalized = Number.isFinite(seed) ? Math.trunc(seed) : 0;
	let state = Math.imul(normalized + 0x6d2b79f5, 0x9e3779b1);
	state ^= state >>> 16;
	state = Math.imul(state, 0x7feb352d);
	state ^= state >>> 15;
	return (state >>> 0) / 4294967296;
};

const assertDuration = (durationInFrames: number): void => {
	if (!Number.isInteger(durationInFrames) || durationInFrames < 1) {
		throw domainInvariant('Sprite durationInFrames must be a positive integer');
	}
};

const assertAssetId = (
	assetId: string | undefined,
	message: string,
): string => {
	if (!assetId || !assetId.trim()) {
		throw domainInvariant(message);
	}

	return assetId;
};

const pushState = (
	states: SpriteState[],
	frame: number,
	assetId: string,
	durationInFrames: number,
): void => {
	if (!Number.isInteger(frame) || frame < 0 || frame >= durationInFrames) {
		return;
	}

	const existing = states.findIndex((state) => state.frame === frame);
	if (existing >= 0) {
		states[existing] = {frame, assetId};
		return;
	}

	const previous = [...states].reverse().find((state) => state.frame < frame);
	if (previous?.assetId === assetId) {
		return;
	}

	states.push({frame, assetId});
	states.sort((left, right) => left.frame - right.frame);
};

const isMouthShape = (value: string | undefined): value is MouthShape => {
	return (
		value !== undefined && (MOUTH_SHAPES as readonly string[]).includes(value)
	);
};

const normalizePhoneme = (phoneme: string | undefined): string => {
	return phoneme?.trim().toLowerCase() ?? '';
};

const mouthShapeForPhoneme = (phoneme: string | undefined): MouthShape => {
	const normalized = normalizePhoneme(phoneme);
	if (
		!normalized ||
		normalized === 'sil' ||
		normalized === 'silence' ||
		normalized === 'sp' ||
		normalized === 'pau' ||
		normalized === 'pause' ||
		normalized === 'rest'
	) {
		return 'closed';
	}

	if (
		/[aeiou]/.test(normalized) ||
		[
			'aa',
			'ae',
			'ah',
			'ao',
			'aw',
			'ay',
			'eh',
			'er',
			'ey',
			'ih',
			'iy',
			'ow',
			'oy',
			'uh',
			'uw',
		].includes(normalized)
	) {
		return 'open';
	}

	return 'half';
};

const assetForMouthShape = (
	shape: MouthShape,
	assetIds: MouthFlapSpriteInput['assetIds'],
): string => {
	if (shape === 'open') {
		return assetIds.open;
	}

	if (shape === 'half') {
		return assetIds.half ?? assetIds.open;
	}

	return assetIds.closed;
};

const validatePhonemeCues = (
	cues: readonly PhonemeMouthCue[],
	durationInFrames: number,
): PhonemeMouthCue[] => {
	const ordered = cues
		.map((cue) => ({...cue}))
		.sort((left, right) => {
			return left.from - right.from;
		});
	let previousEnd = 0;
	for (const cue of ordered) {
		if (
			!Number.isInteger(cue.from) ||
			!Number.isInteger(cue.durationInFrames) ||
			cue.durationInFrames < 1 ||
			cue.from < 0 ||
			cue.from + cue.durationInFrames > durationInFrames
		) {
			throw domainInvariant('Mouth flap phoneme cue falls outside the item');
		}

		if (cue.from < previousEnd) {
			throw domainInvariant('Mouth flap phoneme cues overlap');
		}

		if (cue.mouthShape !== undefined && !isMouthShape(cue.mouthShape)) {
			throw domainInvariant('Mouth flap phoneme cue mouthShape is invalid');
		}

		previousEnd = cue.from + cue.durationInFrames;
	}

	return ordered;
};

const buildPhonemeMouthStates = (
	input: MouthFlapSpriteInput,
): SpriteState[] => {
	const cues = validatePhonemeCues(
		input.phonemeCues ?? [],
		input.durationInFrames,
	);
	if (cues.length === 0) {
		return [];
	}

	const states: SpriteState[] = [];
	pushState(states, 0, input.assetIds.closed, input.durationInFrames);
	let previousEnd = 0;
	for (const cue of cues) {
		if (cue.from > previousEnd) {
			pushState(
				states,
				previousEnd,
				input.assetIds.closed,
				input.durationInFrames,
			);
		}

		const shape = cue.mouthShape ?? mouthShapeForPhoneme(cue.phoneme);
		pushState(
			states,
			cue.from,
			assetForMouthShape(shape, input.assetIds),
			input.durationInFrames,
		);
		previousEnd = cue.from + cue.durationInFrames;
	}

	if (previousEnd < input.durationInFrames) {
		pushState(
			states,
			previousEnd,
			input.assetIds.closed,
			input.durationInFrames,
		);
	}

	return states;
};

export const buildBlinkSpriteStates = (
	input: BlinkSpriteInput,
): SpriteState[] => {
	assertDuration(input.durationInFrames);
	const openAssetId = assertAssetId(
		input.openAssetId,
		'Blink requires open and closed assets',
	);
	const closedAssetId = assertAssetId(
		input.closedAssetId,
		'Blink requires open and closed assets',
	);
	if (!Number.isFinite(input.seed)) {
		throw domainInvariant('Blink seed must be a finite number');
	}

	const fps = input.fps ?? COMIC_DEFAULT_FPS;
	const closedFrames = Math.max(1, Math.round(fps * 0.08));
	const interval = Math.max(closedFrames + 1, Math.round(fps));
	const phase = Math.floor(
		unitFromSeed(input.seed) * Math.max(1, interval - closedFrames),
	);
	const states: SpriteState[] = [];
	pushState(states, 0, openAssetId, input.durationInFrames);
	for (let start = phase; start < input.durationInFrames; start += interval) {
		pushState(states, start, closedAssetId, input.durationInFrames);
		pushState(
			states,
			start + closedFrames,
			openAssetId,
			input.durationInFrames,
		);
	}

	return states;
};

export const buildMouthFlapSpriteStates = (
	input: MouthFlapSpriteInput,
): SpriteState[] => {
	assertDuration(input.durationInFrames);
	const closed = assertAssetId(
		input.assetIds.closed,
		'Mouth flap requires closed and open assets',
	);
	const open = assertAssetId(
		input.assetIds.open,
		'Mouth flap requires closed and open assets',
	);
	if (input.assetIds.half !== undefined) {
		assertAssetId(input.assetIds.half, 'Mouth flap half asset cannot be empty');
	}

	const phonemeStates = buildPhonemeMouthStates(input);
	if (phonemeStates.length > 0) {
		return phonemeStates;
	}

	const sequence = [closed, input.assetIds.half, open].filter(
		(assetId): assetId is string => Boolean(assetId && assetId.trim()),
	);
	const fps = input.fps ?? COMIC_DEFAULT_FPS;
	const step = Math.max(1, Math.ceil(fps / MAX_SPRITE_SWITCHES_PER_SECOND));
	const ranges = [...input.dialogueRanges].sort(
		(left, right) => left.from - right.from,
	);
	let previousEnd = 0;
	for (const range of ranges) {
		if (
			!Number.isInteger(range.from) ||
			!Number.isInteger(range.durationInFrames) ||
			range.durationInFrames < 1 ||
			range.from < 0 ||
			range.from + range.durationInFrames > input.durationInFrames
		) {
			throw domainInvariant('Mouth flap dialogue falls outside the item');
		}

		if (range.from < previousEnd) {
			throw domainInvariant('Mouth flap dialogue ranges overlap');
		}

		previousEnd = range.from + range.durationInFrames;
	}

	const states: SpriteState[] = [];
	pushState(states, 0, closed, input.durationInFrames);
	for (const range of ranges) {
		let viseme = 0;
		for (
			let frame = range.from;
			frame < range.from + range.durationInFrames;
			frame += step
		) {
			pushState(
				states,
				frame,
				sequence[viseme % sequence.length] ?? closed,
				input.durationInFrames,
			);
			viseme += 1;
		}

		const end = range.from + range.durationInFrames;
		const last = states[states.length - 1];
		if (end < input.durationInFrames && last && end - last.frame >= step) {
			pushState(states, end, closed, input.durationInFrames);
		} else if (last && last.frame >= range.from) {
			states[states.length - 1] = {frame: last.frame, assetId: closed};
		}
	}

	return states;
};
