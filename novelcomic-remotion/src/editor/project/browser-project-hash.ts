import {projectContentHash} from '../comic/content-hash';
import type {UndoableState} from '../state/types';

/**
 * Browser persistence and server delivery must identify the same project
 * content. Keep one canonical serializer/hash implementation so a graph-only
 * edit cannot be mistaken for an unchanged snapshot.
 */
export const browserProjectHash = (state: UndoableState): string =>
	projectContentHash(state);
