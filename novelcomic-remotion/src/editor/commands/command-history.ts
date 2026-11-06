import type {CommandBus} from './command-bus';
import type {CommandTransactionResult, ProjectCommand} from './types';

export const MAX_COMMAND_HISTORY = 100;
export const COMMAND_MERGE_WINDOW_MS = 300;

type CommandHistoryEntry = {
	commands: ProjectCommand[];
	inverses: ProjectCommand[];
	committedAt: number;
	mergeKey?: string;
};

export type HistoryResult<TState> = {
	state: TState;
	commandCount: number;
};

export class CommandHistory<TState> {
	private undoEntries: CommandHistoryEntry[] = [];
	private redoEntries: CommandHistoryEntry[] = [];
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly bus: CommandBus<TState>,
		private readonly options: {
			maxEntries?: number;
			mergeWindowMs?: number;
			now?: () => number;
		} = {},
	) {}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	canUndo = (): boolean => this.undoEntries.length > 0;
	canRedo = (): boolean => this.redoEntries.length > 0;

	clear(): void {
		this.undoEntries = [];
		this.redoEntries = [];
		this.emit();
	}

	execute(state: TState, command: ProjectCommand): HistoryResult<TState> {
		const result = this.bus.executeTransaction(state, [command]);
		this.record(result);
		return {state: result.state, commandCount: 1};
	}

	executeTransaction(
		state: TState,
		commands: readonly ProjectCommand[],
		transactionId?: string,
	): HistoryResult<TState> {
		if (commands.length === 0) return {state, commandCount: 0};
		const result = this.bus.executeTransaction(state, commands, transactionId);
		this.record(result);
		return {state: result.state, commandCount: commands.length};
	}

	undo(state: TState): HistoryResult<TState> {
		const entry = this.undoEntries.pop();
		if (!entry) return {state, commandCount: 0};
		const result = this.bus.executeTransaction(state, entry.inverses);
		this.redoEntries.push(entry);
		this.emit();
		return {state: result.state, commandCount: entry.commands.length};
	}

	redo(state: TState): HistoryResult<TState> {
		const entry = this.redoEntries.pop();
		if (!entry) return {state, commandCount: 0};
		const result = this.bus.executeTransaction(state, entry.commands);
		this.undoEntries.push(entry);
		this.emit();
		return {state: result.state, commandCount: entry.commands.length};
	}

	private record(result: CommandTransactionResult<TState>): void {
		const now = this.options.now?.() ?? Date.now();
		const next: CommandHistoryEntry = {
			commands: result.commands,
			inverses: result.inverses,
			committedAt: now,
			...(result.commands.length === 1 && result.commands[0]?.mergeKey
				? {mergeKey: result.commands[0].mergeKey}
				: {}),
		};
		const previous = this.undoEntries.at(-1);
		const mergeWindowMs = this.options.mergeWindowMs ?? COMMAND_MERGE_WINDOW_MS;
		if (
			previous &&
			previous.mergeKey &&
			previous.mergeKey === next.mergeKey &&
			now - previous.committedAt <= mergeWindowMs
		) {
			this.undoEntries[this.undoEntries.length - 1] = {
				commands: [...previous.commands, ...next.commands],
				inverses: [...next.inverses, ...previous.inverses],
				committedAt: now,
				mergeKey: previous.mergeKey,
			};
		} else {
			this.undoEntries.push(next);
			const maxEntries = this.options.maxEntries ?? MAX_COMMAND_HISTORY;
			if (this.undoEntries.length > maxEntries) {
				this.undoEntries.splice(0, this.undoEntries.length - maxEntries);
			}
		}
		this.redoEntries = [];
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}
