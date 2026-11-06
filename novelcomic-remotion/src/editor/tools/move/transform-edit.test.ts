import {beforeEach, describe, expect, it} from 'vitest';
import {DocumentCommandHistory} from '../../commands/document-command-history';
import type {DocumentCommand} from '../../commands/document-command-types';
import {createEmptyDocument, createShapeLayer} from '../../document/defaults';
import type {DocumentState, LayerNode} from '../../document/types';
import {heldFlagsFor} from './held-modifiers';
import {readToolBool} from './move-tool-settings';
import {
	beginTransformEdit,
	cancelTransformEdit,
	commitTransformEdit,
	previewTransformEdit,
	resetTransformEdit,
} from './transform-edit';

const add = (document: DocumentState, layer: LayerNode) => {
	layer.parentId = null;
	document.layers[layer.id] = layer;
	document.rootLayerIds = [...document.rootLayerIds, layer.id];
	return layer;
};

const harness = () => {
	const document = createEmptyDocument({width: 400, height: 300, projectId: 'p'});
	const layer = add(document, createShapeLayer('rectangle', 'Layer', 100, 80));
	layer.transform = {...layer.transform, originX: 10, originY: 20, rotation: 15};
	const history = new DocumentCommandHistory();
	let current = document;
	const dispatch = (commands: readonly DocumentCommand[]) => {
		current = history.executeTransaction(current, commands);
	};
	return {
		history,
		document,
		layer,
		dispatch,
		get documentNow() {
			return current;
		},
	};
};

describe('transform edit', () => {
	beforeEach(() => resetTransformEdit());

	it('previews field changes and commits them as one undo', () => {
		const tool = harness();
		const began = beginTransformEdit({
			document: tool.document,
			selectedIds: [tool.layer.id],
			activeLayerId: tool.layer.id,
			fromFields: true,
		});
		expect(began?.fromFields).toBe(true);
		previewTransformEdit({...began!.draft, originX: 40});
		previewTransformEdit({...began!.draft, originX: 40, originY: 55});
		expect(tool.history.canUndo).toBe(false);
		expect(tool.documentNow.layers[tool.layer.id]?.transform.originX).toBe(10);
		commitTransformEdit(tool.dispatch);
		expect(tool.documentNow.layers[tool.layer.id]?.transform.originX).toBe(40);
		expect(tool.documentNow.layers[tool.layer.id]?.transform.originY).toBe(55);
		expect(tool.history.canUndo).toBe(true);
		const undone = tool.history.undo(tool.documentNow);
		expect(undone.layers[tool.layer.id]?.transform.originX).toBe(10);
		expect(undone.layers[tool.layer.id]?.transform.originY).toBe(20);
	});

	it('toggles flip without mirroring the layer across the canvas', () => {
		const tool = harness();
		const began = beginTransformEdit({
			document: tool.document,
			selectedIds: [tool.layer.id],
			activeLayerId: tool.layer.id,
			fromFields: true,
		});
		previewTransformEdit({...began!.draft, flipX: !began!.draft.flipX});
		commitTransformEdit(tool.dispatch);
		const next = tool.documentNow.layers[tool.layer.id]?.transform;
		expect(next?.scaleX).toBe(-1);
		expect(next?.originX).toBe(10);
		expect(next?.originY).toBe(20);
		expect(next?.rotation).toBe(15);
	});

	it('pins an unlinked mask when the layer moves and carries a linked one', () => {
		const tool = harness();
		tool.document.assets.mask = {
			id: 'mask',
			kind: 'mask',
			originalName: 'mask.png',
			mimeType: 'image/png',
			byteSize: 1,
			objectKey: 'mask',
			contentHash: 'mask',
		};
		tool.layer.mask = {
			assetId: 'mask',
			enabled: true,
			linkedToLayer: false,
			invert: false,
			feather: 0,
		};
		const began = beginTransformEdit({
			document: tool.document,
			selectedIds: [tool.layer.id],
			activeLayerId: tool.layer.id,
			fromFields: true,
		});
		previewTransformEdit({...began!.draft, originX: 40});
		commitTransformEdit(tool.dispatch);
		expect(tool.documentNow.layers[tool.layer.id]?.transform.originX).toBe(40);
		expect(tool.documentNow.layers[tool.layer.id]?.mask?.placement?.originX).toBe(10);

		resetTransformEdit();
		const linked = tool.documentNow.layers[tool.layer.id]!;
		linked.mask = {...linked.mask!, linkedToLayer: true, placement: {...linked.transform, originX: 4}};
		const again = beginTransformEdit({
			document: tool.documentNow,
			selectedIds: [tool.layer.id],
			activeLayerId: tool.layer.id,
			fromFields: true,
		});
		previewTransformEdit({...again!.draft, originX: 50});
		commitTransformEdit(tool.dispatch);
		expect(tool.documentNow.layers[tool.layer.id]?.mask?.placement?.originX).toBe(14);
	});

	it('drops a field preview on cancel', () => {
		const tool = harness();
		const began = beginTransformEdit({
			document: tool.document,
			selectedIds: [tool.layer.id],
			activeLayerId: tool.layer.id,
			fromFields: true,
		});
		previewTransformEdit({...began!.draft, originX: 80});
		expect(cancelTransformEdit()).toBe(true);
		commitTransformEdit(tool.dispatch);
		expect(tool.history.canUndo).toBe(false);
		expect(tool.documentNow.layers[tool.layer.id]?.transform.originX).toBe(10);
	});
});

describe('move bar modifiers and defaults', () => {
	it('ignores command and shift while a field is being typed in', () => {
		expect(heldFlagsFor({meta: true, shift: true}, true)).toEqual({
			command: false,
			shift: false,
		});
		expect(heldFlagsFor({meta: true, shift: false}, false)).toEqual({
			command: true,
			shift: false,
		});
	});

	it('reads Auto Select and Show Controls the way ToolDefaults does', () => {
		const storage = {
			getItem: (key: string) =>
				key === 'tool.autoSelect' ? 'true' : key === 'tool.transformControls' ? 'false' : null,
		};
		expect(readToolBool(storage, 'autoSelect', false)).toBe(true);
		expect(readToolBool(storage, 'transformControls', true)).toBe(false);
		expect(readToolBool(storage, 'lockRatio', true)).toBe(true);
	});
});
