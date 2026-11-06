import {describe, expect, it} from 'vitest';
import {createEmptyDocument} from '../document';
import {ProjectWorkspace} from './project-workspace';

describe('ProjectWorkspace', () => {
	it('keeps tabs, recents, dirty close protection, and external reload separate', () => {
		const document = createEmptyDocument({projectId: 'project-1'}); const workspace = new ProjectWorkspace(); workspace.open(document, 'hash-1'); workspace.update({...document, name: 'Edited'}); expect(workspace.close('project-1')).toBe(false); expect(workspace.close('project-1', 'discard')).toBe(true);
		workspace.open(document, 'hash-1'); workspace.applyExternalChange('project-1', {...document, name: 'External'}, 'hash-2', 'reload'); expect(workspace.activeTab?.document.name).toBe('External'); expect(workspace.recentProjectIds[0]).toBe('project-1');
	});
});
