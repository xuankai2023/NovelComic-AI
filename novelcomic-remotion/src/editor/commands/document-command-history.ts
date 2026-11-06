import type {DocumentState} from '../document';
import {documentCommandBus} from './document-command-bus';
import type {
	DocumentCommand,
	DocumentCommandTransactionResult,
} from './document-command-types';

export const DOCUMENT_COMMAND_MERGE_WINDOW_MS = 300;
type Entry = {
	commands: DocumentCommand[];
	inverses: DocumentCommand[];
	committedAt: number;
	mergeKey?: string;
};
export class DocumentCommandHistory {
	private undoEntries: Entry[] = [];
	private redoEntries: Entry[] = [];
	constructor(
		private readonly options: {
			maxEntries?: number;
			mergeWindowMs?: number;
			now?: () => number;
		} = {},
	) {}
	get canUndo() {
		return this.undoEntries.length > 0;
	}
	get canRedo() {
		return this.redoEntries.length > 0;
	}
	clear() {
		this.undoEntries = [];
		this.redoEntries = [];
	}
	execute(document: DocumentState, command: DocumentCommand) {
		const result = documentCommandBus.executeTransaction(document, [command]);
		this.record(result);
		return result.document;
	}
	executeTransaction(
		document: DocumentState,
		commands: readonly DocumentCommand[],
		transactionId?: string,
	) {
		if (!commands.length) return document;
		const result = documentCommandBus.executeTransaction(
			document,
			commands,
			transactionId,
		);
		this.record(result);
		return result.document;
	}
	undo(document: DocumentState) {
		const entry = this.undoEntries.pop();
		if (!entry) return document;
		const result = documentCommandBus.executeTransaction(
			document,
			entry.inverses,
		);
		this.redoEntries.push(entry);
		return result.document;
	}
	redo(document: DocumentState) {
		const entry = this.redoEntries.pop();
		if (!entry) return document;
		const result = documentCommandBus.executeTransaction(
			document,
			entry.commands,
		);
		this.undoEntries.push(entry);
		return result.document;
	}
	private record(result: DocumentCommandTransactionResult) {
		const now = this.options.now?.() ?? Date.now();
		const next: Entry = {
			commands: result.commands,
			inverses: result.inverses,
			committedAt: now,
			mergeKey:
				result.commands.length === 1 ? result.commands[0].mergeKey : undefined,
		};
		const previous = this.undoEntries.at(-1);
		const window =
			this.options.mergeWindowMs ?? DOCUMENT_COMMAND_MERGE_WINDOW_MS;
		if (
			previous?.mergeKey &&
			previous.mergeKey === next.mergeKey &&
			now - previous.committedAt <= window
		)
			this.undoEntries[this.undoEntries.length - 1] = {
				commands: [...previous.commands, ...next.commands],
				inverses: [...next.inverses, ...previous.inverses],
				committedAt: now,
				mergeKey: previous.mergeKey,
			};
		else {
			this.undoEntries.push(next);
			const max = this.options.maxEntries ?? 100;
			if (this.undoEntries.length > max)
				this.undoEntries.splice(0, this.undoEntries.length - max);
		}
		this.redoEntries = [];
	}
}
