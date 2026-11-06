import type {DocumentState} from '../document';
import type {DocumentRepository} from './document-repository';

/** Narrow bridge for the legacy project shell. It intentionally exposes only documents. */
export class DocumentProjectAdapter {
	constructor(private readonly repository: DocumentRepository) {}
	create(document: DocumentState) {
		return this.repository.createProject(document.projectId, document);
	}
	load(projectId: string) {
		return this.repository.getCurrentSnapshot(projectId);
	}
	saveDraft(document: DocumentState) {
		return this.repository.writeDraft(document.projectId, document);
	}
	commit(
		command: Parameters<DocumentRepository['commit']>[0],
		document: DocumentState,
	) {
		return this.repository.commit(command, document);
	}
}
