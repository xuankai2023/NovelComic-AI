import {describe, expect, it} from 'vitest';
import {createEmptyDocument} from '../document';
import {DocumentCommandHistory} from './document-command-history';
import {createDocumentCommand} from './document-command-types';

describe('DocumentCommandHistory', () => {
	it('undoes and redoes commands', () => {
		const history = new DocumentCommandHistory();
		const initial = createEmptyDocument({projectId: 'p'});
		const command = createDocumentCommand({
			projectId: 'p',
			type: 'document.rename',
			payload: {name: 'A'},
		});
		const changed = history.execute(initial, command);
		expect(changed.name).toBe('A');
		expect(history.undo(changed).name).toBe(initial.name);
		expect(history.redo(initial).name).toBe('A');
	});
});
