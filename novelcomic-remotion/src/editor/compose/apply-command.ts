import {
	COMIC_ERROR_CODES,
	ComicEditorError,
	domainInvariant,
} from '../comic/errors';
import {reorderComicTracks} from '../comic/reorder-comic-tracks';
import {validateProject} from '../comic/validate-project';
import {normalizeUndoableState} from '../state/normalize-undoable-state';
import type {UndoableState} from '../state/types';

export type ApplyCommandInput<T> = {
	project: UndoableState;
	command: (project: UndoableState) => T;
};

export type ApplyCommandResult<T> =
	| {ok: true; value: T}
	| {ok: false; error: ComicEditorError};

const asProject = (value: unknown): UndoableState | null => {
	if (!value || typeof value !== 'object') {
		return null;
	}

	if (!('tracks' in value) || !('items' in value) || !('assets' in value)) {
		return null;
	}

	return value as UndoableState;
};

export const applyCommand = <T>(
	input: ApplyCommandInput<T>,
): ApplyCommandResult<T> => {
	try {
		const normalized = normalizeUndoableState(input.project);
		const commanded = input.command(normalized);
		const project = asProject(commanded);
		if (!project) {
			return {ok: true, value: commanded};
		}

		const reordered = reorderComicTracks(project);
		const issue = validateProject(reordered).find((entry) => {
			return entry.severity === 'error';
		});
		if (issue) {
			return {
				ok: false,
				error: domainInvariant(issue.message, {
					shotId: issue.shotId,
					itemId: issue.itemId,
					assetId: issue.assetId,
				}),
			};
		}

		return {ok: true, value: reordered as T};
	} catch (error) {
		if (error instanceof ComicEditorError) {
			return {ok: false, error};
		}

		return {
			ok: false,
			error: new ComicEditorError({
				code: COMIC_ERROR_CODES.INTERNAL,
				message: error instanceof Error ? error.message : 'Internal error',
				retryable: false,
				status: 500,
			}),
		};
	}
};
