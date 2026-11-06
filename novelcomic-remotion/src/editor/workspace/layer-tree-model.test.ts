import {describe, expect, it} from 'vitest';
import {createEmptyDocument, createGroupLayer, createTextLayer} from '../document';
import {DocumentCommandBus} from '../commands/document-command-bus';
import {createDocumentCommand} from '../commands/document-command-types';
import {buildLayerTreeRows, canDropLayer} from './layer-tree-model';

describe('compositor layer tree model', () => {
	it('flattens expanded groups in document order', () => {
		const bus = new DocumentCommandBus();
		let document = createEmptyDocument({projectId: 'p'});
		const group = createGroupLayer('Group');
		const text = createTextLayer('Text');
		text.parentId = group.id;
		document = bus.execute(document, createDocumentCommand({projectId: 'p', type: 'layer.create', payload: {layer: group}})).document;
		document = bus.execute(document, createDocumentCommand({projectId: 'p', type: 'layer.create', payload: {layer: text}})).document;
		expect(buildLayerTreeRows(document, new Set()).map((row) => row.layer.id)).toEqual([group.id]);
		expect(buildLayerTreeRows(document, new Set([group.id])).map((row) => row.layer.id)).toEqual([group.id, text.id]);
		expect(buildLayerTreeRows(document, new Set([group.id]))[1].depth).toBe(1);
	});

	it('rejects dropping a group into its own descendant', () => {
		const bus = new DocumentCommandBus();
		let document = createEmptyDocument({projectId: 'p'});
		const parent = createGroupLayer('Parent');
		const child = createGroupLayer('Child');
		child.parentId = parent.id;
		document = bus.execute(document, createDocumentCommand({projectId: 'p', type: 'layer.create', payload: {layer: parent}})).document;
		document = bus.execute(document, createDocumentCommand({projectId: 'p', type: 'layer.create', payload: {layer: child}})).document;
		expect(canDropLayer(document, parent.id, child.id)).toBe(false);
		expect(canDropLayer(document, child.id, null)).toBe(true);
	});
});
