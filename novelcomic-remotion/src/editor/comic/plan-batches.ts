import type {EditorStarterItem} from '../items/item-type';
import type {UndoableState} from '../state/types';
import {hashContent, projectContentHash} from './content-hash';
import {COMIC_ERROR_CODES, ComicEditorError, domainInvariant} from './errors';
import {
	MAX_BATCH_SECONDS,
	MIN_BATCH_SECONDS,
	batchDurationFrames,
} from './limits';
import type {OutputBatch, Shot} from './types';

type Atom = {
	shots: Shot[];
	fromFrame: number;
	endExclusive: number;
};

type DraftBatch = {
	atoms: Atom[];
	rebalanced: boolean;
};

const batchIdFor = (
	contentHash: string,
	fromFrame: number,
	endFrameInclusive: number,
	shotIds: readonly string[],
): string => {
	return hashContent({
		contentHash,
		fromFrame,
		endFrameInclusive,
		shotIds,
	});
};

const tailRebalanceFailed = (message: string): ComicEditorError => {
	return new ComicEditorError({
		code: COMIC_ERROR_CODES.TAIL_REBALANCE_FAILED,
		message,
		retryable: false,
		status: 422,
	});
};

const itemEndFrame = (project: UndoableState): number => {
	let maxEnd = 0;
	for (const item of Object.values(project.items)) {
		const end = item.from + item.durationInFrames;
		if (end > maxEnd) {
			maxEnd = end;
		}
	}

	return maxEnd;
};

const shotEnd = (shot: Shot): number => {
	return shot.from + shot.durationInFrames;
};

const crossesBoundary = (
	from: number,
	durationInFrames: number,
	boundary: number,
): boolean => {
	return from < boundary && from + durationInFrames > boundary;
};

const isNecessarySound = (
	project: UndoableState,
	item: EditorStarterItem,
): boolean => {
	if (item.type !== 'audio') {
		return false;
	}

	return project.tracks.some((track) => {
		return (
			track.items.includes(item.id) &&
			(track.shotId !== undefined || track.semantic === 'effect')
		);
	});
};

const isProtectedMedia = (
	project: UndoableState,
	item: EditorStarterItem,
): boolean => {
	return item.type === 'captions' || isNecessarySound(project, item);
};

const boundaryIsProtected = (
	project: UndoableState,
	left: Shot,
	right: Shot,
): boolean => {
	if (right.from < shotEnd(left) || left.transitionOut?.type === 'crossfade') {
		return true;
	}

	const boundary = right.from;
	for (const item of Object.values(project.items)) {
		if (!isProtectedMedia(project, item)) {
			continue;
		}

		if (crossesBoundary(item.from, item.durationInFrames, boundary)) {
			return true;
		}
	}

	for (const itemId of left.dialogueItemIds) {
		const item = project.items[itemId];
		if (!item) {
			continue;
		}

		if (crossesBoundary(item.from, item.durationInFrames, boundary)) {
			return true;
		}
	}

	return false;
};

const span = (atoms: readonly Atom[]): number => {
	return atoms[atoms.length - 1].endExclusive - atoms[0].fromFrame;
};

const toAtom = (shots: readonly Shot[]): Atom => {
	const first = shots[0];
	const last = shots[shots.length - 1];
	return {
		shots: [...shots],
		fromFrame: first.from,
		endExclusive: shotEnd(last),
	};
};

const buildAtoms = (project: UndoableState, shots: readonly Shot[]): Atom[] => {
	const groups: Shot[][] = [];
	let current: Shot[] = [shots[0]];
	for (let index = 0; index < shots.length - 1; index++) {
		const left = shots[index];
		const right = shots[index + 1];
		if (boundaryIsProtected(project, left, right)) {
			current.push(right);
			continue;
		}

		groups.push(current);
		current = [right];
	}

	groups.push(current);
	const atoms = groups.map((group) => toAtom(group));
	if (atoms[0].fromFrame > 0) {
		atoms[0] = {...atoms[0], fromFrame: 0};
	}

	for (let index = 0; index < atoms.length - 1; index++) {
		const nextFrom = atoms[index + 1].fromFrame;
		if (atoms[index].endExclusive < nextFrom) {
			atoms[index] = {...atoms[index], endExclusive: nextFrom};
		}

		if (atoms[index].endExclusive > nextFrom) {
			throw domainInvariant(
				'Overlapping shots cannot be placed in different batches',
				{shotId: atoms[index].shots[0]?.id},
			);
		}
	}

	const last = atoms[atoms.length - 1];
	const end = Math.max(last.endExclusive, itemEndFrame(project));
	if (end > last.endExclusive) {
		atoms[atoms.length - 1] = {...last, endExclusive: end};
	}

	return atoms;
};

const packAtoms = (atoms: readonly Atom[], maxFrames: number): DraftBatch[] => {
	const drafts: DraftBatch[] = [];
	let current: Atom[] = [];
	for (const atom of atoms) {
		if (current.length === 0) {
			current = [atom];
			continue;
		}

		const combined = atom.endExclusive - current[0].fromFrame;
		if (combined <= maxFrames) {
			current.push(atom);
			continue;
		}

		drafts.push({atoms: current, rebalanced: false});
		current = [atom];
	}

	if (current.length > 0) {
		drafts.push({atoms: current, rebalanced: false});
	}

	return drafts;
};

const rebalanceTail = (
	drafts: DraftBatch[],
	minFrames: number,
	maxFrames: number,
): void => {
	const tail = drafts[drafts.length - 1];
	if (!tail || span(tail.atoms) >= minFrames) {
		return;
	}

	if (drafts.length < 2) {
		throw tailRebalanceFailed(
			`Tail batch is shorter than ${MIN_BATCH_SECONDS} seconds and cannot be rebalanced`,
		);
	}

	const previous = drafts[drafts.length - 2];
	for (let count = 1; count <= previous.atoms.length; count++) {
		const stay = previous.atoms.slice(0, -count);
		const moved = previous.atoms.slice(-count);
		const nextTail = [...moved, ...tail.atoms];
		const nextTailDuration = span(nextTail);
		if (nextTailDuration < minFrames || nextTailDuration > maxFrames) {
			continue;
		}

		if (stay.length === 0) {
			const mergedDuration = span(nextTail);
			if (mergedDuration < minFrames || mergedDuration > maxFrames) {
				continue;
			}

			drafts.splice(drafts.length - 2, 2, {
				atoms: nextTail,
				rebalanced: true,
			});
			return;
		}

		const stayDuration = span(stay);
		if (stayDuration < minFrames || stayDuration > maxFrames) {
			continue;
		}

		drafts[drafts.length - 2] = {atoms: stay, rebalanced: true};
		drafts[drafts.length - 1] = {atoms: nextTail, rebalanced: true};
		return;
	}

	throw tailRebalanceFailed(
		`Tail batch is shorter than ${MIN_BATCH_SECONDS} seconds and cannot be rebalanced`,
	);
};

const assertBatchRanges = (
	batches: readonly OutputBatch[],
	projectEnd: number,
	minFrames: number,
	maxFrames: number,
): void => {
	if (batches.length === 0) {
		throw domainInvariant('Batch plan produced no batches');
	}

	let cursor = 0;
	const seenShots = new Set<string>();
	for (const batch of batches) {
		if (batch.fromFrame !== cursor) {
			throw domainInvariant(
				`Batch ${batch.batchIndex} leaves a frame gap or overlap at ${cursor}`,
			);
		}

		const inclusive = batch.endFrameInclusive - batch.fromFrame + 1;
		if (inclusive !== batch.durationInFrames) {
			throw domainInvariant(
				`Batch ${batch.batchIndex} duration does not include both endpoints`,
			);
		}

		if (batch.durationInFrames > maxFrames) {
			throw domainInvariant(
				`Batch ${batch.batchIndex} exceeds ${MAX_BATCH_SECONDS} seconds`,
			);
		}

		if (batch.durationInFrames < minFrames) {
			throw tailRebalanceFailed(
				`Batch ${batch.batchIndex} is shorter than ${MIN_BATCH_SECONDS} seconds and cannot be rebalanced`,
			);
		}

		for (const shotId of batch.shotIds) {
			if (seenShots.has(shotId)) {
				throw domainInvariant(`Shot ${shotId} is repeated across batches`, {
					shotId,
				});
			}

			seenShots.add(shotId);
		}

		cursor = batch.endFrameInclusive + 1;
	}

	if (cursor !== projectEnd) {
		throw domainInvariant('Batch plan does not cover the project timeline');
	}
};

export const planOutputBatches = (project: UndoableState): OutputBatch[] => {
	const shots = [...(project.shots ?? [])].sort((left, right) => {
		return left.from - right.from || left.id.localeCompare(right.id);
	});
	if (shots.length === 0) {
		throw domainInvariant('Project has no shots to plan into batches');
	}

	if (!Number.isFinite(project.fps) || project.fps <= 0) {
		throw domainInvariant('Project fps must be positive');
	}

	const limits = batchDurationFrames(project.fps);
	for (const shot of shots) {
		if (
			!Number.isInteger(shot.from) ||
			shot.from < 0 ||
			!Number.isInteger(shot.durationInFrames) ||
			shot.durationInFrames < 1
		) {
			throw domainInvariant(`Shot ${shot.id} has an invalid frame range`, {
				shotId: shot.id,
			});
		}

		if (shot.durationInFrames > limits.max) {
			throw domainInvariant(
				`Shot ${shot.id} exceeds ${MAX_BATCH_SECONDS} seconds`,
				{shotId: shot.id},
			);
		}
	}

	const atoms = buildAtoms(project, shots);
	const projectEnd = atoms[atoms.length - 1].endExclusive;
	if (projectEnd < limits.min) {
		throw domainInvariant(
			`Project is shorter than ${MIN_BATCH_SECONDS} seconds; pad it before planning batches`,
		);
	}

	for (const atom of atoms) {
		const duration = atom.endExclusive - atom.fromFrame;
		if (duration > limits.max) {
			const shotIds = atom.shots.map((shot) => shot.id).join(', ');
			throw domainInvariant(
				`Shots ${shotIds} cannot be split without cutting crossfade, dialogue, or sound effects, and exceed ${MAX_BATCH_SECONDS} seconds`,
				{shotId: atom.shots[0]?.id},
			);
		}
	}

	const drafts = packAtoms(atoms, limits.max);
	rebalanceTail(drafts, limits.min, limits.max);
	const contentHash = projectContentHash(project);
	const batches = drafts.map((draft, index): OutputBatch => {
		const fromFrame = draft.atoms[0].fromFrame;
		const endExclusive = draft.atoms[draft.atoms.length - 1].endExclusive;
		const durationInFrames = endExclusive - fromFrame;
		const shotIds = draft.atoms.flatMap((atom) => {
			return atom.shots.map((shot) => shot.id);
		});
		const reason = draft.rebalanced
			? 'tail-rebalance'
			: durationInFrames >= limits.targetMin
				? 'target-range'
				: 'short-range';
		return {
			batchId: batchIdFor(contentHash, fromFrame, endExclusive - 1, shotIds),
			batchIndex: index + 1,
			fromFrame,
			endFrameInclusive: endExclusive - 1,
			durationInFrames,
			shotIds,
			reason,
		};
	});
	assertBatchRanges(batches, projectEnd, limits.min, limits.max);
	return batches;
};
