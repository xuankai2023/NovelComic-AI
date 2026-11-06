import {describe, expect, it} from 'vitest';
import {
	createEmptyDocument,
	createGroupLayer,
	createTextLayer,
} from '../document';
import {
	DocumentCommandBus,
	DocumentCommandValidationError,
} from './document-command-bus';
import {createDocumentCommand} from './document-command-types';

describe('DocumentCommandBus', () => {
	it('applies and inverts document and layer commands', () => {
		const bus = new DocumentCommandBus();
		const initial = createEmptyDocument({projectId: 'p', documentId: 'd'});
		const renamed = bus.execute(
			initial,
			createDocumentCommand({
				projectId: 'p',
				type: 'document.rename',
				payload: {name: '稿件'},
			}),
		);
		expect(renamed.document.name).toBe('稿件');
		const group = createGroupLayer('组');
		const created = bus.execute(
			renamed.document,
			createDocumentCommand({
				projectId: 'p',
				type: 'layer.create',
				payload: {layer: group},
			}),
		);
		const text = createTextLayer('你好');
		text.parentId = group.id;
		const nested = bus.execute(
			created.document,
			createDocumentCommand({
				projectId: 'p',
				type: 'layer.create',
				payload: {layer: text},
			}),
		);
		const undone = bus.execute(nested.document, nested.inverse);
		expect(undone.document.layers[text.id]).toBeUndefined();
	});
	it('rejects cycles and rolls back transaction', () => {
		const bus = new DocumentCommandBus();
		const document = createEmptyDocument({projectId: 'p'});
		const group = createGroupLayer();
		const withGroup = bus.execute(
			document,
			createDocumentCommand({
				projectId: 'p',
				type: 'layer.create',
				payload: {layer: group},
			}),
		).document;
		expect(() =>
			bus.execute(
				withGroup,
				createDocumentCommand({
					projectId: 'p',
					type: 'layer.reorder',
					payload: {layerId: group.id, parentId: group.id, order: 0},
				}),
			),
		).toThrow(DocumentCommandValidationError);
	});
});
