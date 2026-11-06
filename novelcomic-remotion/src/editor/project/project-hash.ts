import {
	hashContent,
	projectContentHash,
	stableStringify,
} from '../comic/content-hash';
import type {UndoableState} from '../state/types';

/**
 * Project names and storage metadata must never affect this hash. Hash only the
 * serializable editor state using the same stable SHA-256 representation as the
 * existing comic delivery code.
 */
export const hashProjectState = (state: UndoableState): string =>
	projectContentHash(state);

export {hashContent, projectContentHash, stableStringify};
