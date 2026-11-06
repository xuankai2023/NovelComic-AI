import {
	COMIC_ERROR_CODES,
	ComicEditorError,
} from '../../../../../src/editor/comic/errors';
import {
	editItem,
	type ItemEditPatch,
} from '../../../../../src/editor/compose/edit-item';
import {
	countComposeBody,
	logComposeObservation,
	operationFromRequest,
	readRequestId,
	type ComposeCounts,
} from '../../../../../src/editor/compose/http-response';
import {EditorStarterItem} from '../../../../../src/editor/items/item-type';
import {UndoableState} from '../../../../../src/editor/state/types';

export const runtime = 'nodejs';

type ItemEditRequestBody = {
	project?: UndoableState;
	itemId?: string;
	patch?: ItemEditPatch;
};

type ItemEditResponse =
	| {type: 'success'; project: UndoableState; item: EditorStarterItem}
	| {type: 'error'; error: string};

const NUMERIC_PATCH_FIELDS = [
	'fromMs',
	'durationMs',
	'sourceStartMs',
	'decibelAdjustment',
	'audioFadeInMs',
	'audioFadeOutMs',
	'fadeInMs',
	'fadeOutMs',
	'left',
	'top',
	'width',
	'height',
	'opacity',
	'rotation',
	'cropLeft',
	'cropTop',
	'cropRight',
	'cropBottom',
] as const;

const observeItemEdit = (
	requestId: string,
	startedAt: number,
	operation: string,
	counts: ComposeCounts,
	response: Response,
	code?: (typeof COMIC_ERROR_CODES)[keyof typeof COMIC_ERROR_CODES],
): Response => {
	response.headers.set('x-request-id', requestId);
	logComposeObservation({
		requestId,
		operation,
		durationMs: Date.now() - startedAt,
		itemCount: counts.itemCount,
		shotCount: counts.shotCount,
		assetCount: counts.assetCount,
		code,
	});
	return response;
};

export async function POST(request: Request) {
	const startedAt = Date.now();
	const requestId = readRequestId(request);
	const operation = operationFromRequest(request);
	let counts: ComposeCounts = {itemCount: 0, shotCount: 0, assetCount: 0};

	try {
		const body = (await request.json()) as ItemEditRequestBody;
		counts = countComposeBody(body);

		if (!body.project) {
			throw new Error('project is required');
		}
		if (!body.itemId || typeof body.itemId !== 'string') {
			throw new Error('itemId is required');
		}
		if (!body.patch || Object.keys(body.patch).length === 0) {
			throw new Error('patch is required');
		}

		for (const field of NUMERIC_PATCH_FIELDS) {
			const value = body.patch[field];
			if (value !== undefined && !Number.isFinite(value)) {
				throw new Error(`patch.${field} must be a finite number`);
			}
		}

		const {project, item} = editItem({
			project: body.project,
			itemId: body.itemId,
			patch: body.patch,
		});
		const response: ItemEditResponse = {
			type: 'success',
			project,
			item,
		};
		return observeItemEdit(
			requestId,
			startedAt,
			operation,
			counts,
			Response.json(response),
		);
	} catch (e) {
		const response: ItemEditResponse = {
			type: 'error',
			error: e instanceof Error ? e.message : 'Unknown error',
		};
		const status = e instanceof ComicEditorError ? e.status : 400;
		const code =
			e instanceof ComicEditorError
				? e.code
				: COMIC_ERROR_CODES.INVALID_REQUEST;
		return observeItemEdit(
			requestId,
			startedAt,
			operation,
			counts,
			Response.json(response, {status}),
			code,
		);
	}
}
