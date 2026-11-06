import type {ProjectIssue} from '../comic/types';
import type {UndoableState} from '../state/types';
import {
	MVP_PROJECT_COMMAND_TYPES,
	createCommandId,
	createProjectCommand,
	type AppliedProjectCommand,
	type CommandTransactionResult,
	type MvpProjectCommandType,
	type ProjectCommand,
	type ProjectCommandHandler,
	type StatePatch,
} from './types';

export class CommandValidationError extends Error {
	constructor(
		message: string,
		readonly issues: ProjectIssue[],
	) {
		super(message);
		this.name = 'CommandValidationError';
	}
}

export class CommandBus<TState> {
	private readonly handlers = new Map<
		MvpProjectCommandType,
		ProjectCommandHandler<TState>
	>();

	register(
		type: MvpProjectCommandType,
		handler: ProjectCommandHandler<TState>,
	): this {
		this.handlers.set(type, handler);
		return this;
	}

	validate(command: ProjectCommand, state: TState): ProjectIssue[] {
		const handler = this.handlers.get(command.type);
		if (!handler) {
			return [
				{
					severity: 'error',
					code: 'UNKNOWN_COMMAND',
					message: `No handler is registered for ${command.type}`,
				},
			];
		}

		return handler.validate(command, state);
	}

	execute(
		state: TState,
		command: ProjectCommand,
	): AppliedProjectCommand<TState> {
		const handler = this.handlers.get(command.type);
		const issues = this.validate(command, state);
		const errors = issues.filter((issue) => issue.severity === 'error');
		if (!handler || errors.length > 0) {
			throw new CommandValidationError(
				errors[0]?.message ?? `Cannot execute ${command.type}`,
				issues,
			);
		}

		const applied = handler.apply(state, command);
		return {...applied, command};
	}

	executeTransaction(
		state: TState,
		commands: readonly ProjectCommand[],
		transactionId = createCommandId('transaction'),
	): CommandTransactionResult<TState> {
		let nextState = state;
		const appliedCommands: ProjectCommand[] = [];
		const inverses: ProjectCommand[] = [];

		for (const source of commands) {
			const command = {...source, transactionId};
			const result = this.execute(nextState, command);
			nextState = result.state;
			appliedCommands.push(command);
			inverses.unshift({...result.inverse, transactionId});
		}

		return {state: nextState, commands: appliedCommands, inverses};
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const patchHandler = <
	TState extends object,
>(): ProjectCommandHandler<TState> => ({
	validate: (command) => {
		if (!isRecord(command.payload) || !isRecord(command.payload.changes)) {
			return [
				{
					severity: 'error',
					code: 'INVALID_COMMAND_PAYLOAD',
					message: `${command.type} requires a changes object`,
				},
			];
		}
		if (Object.keys(command.payload.changes).length === 0) {
			return [
				{
					severity: 'error',
					code: 'EMPTY_COMMAND',
					message: `${command.type} does not change project content`,
				},
			];
		}
		return [];
	},
	apply: (state, command) => {
		const changes = (command.payload as StatePatch<TState>).changes;
		const previous = Object.fromEntries(
			Object.keys(changes).map((key) => [key, state[key as keyof TState]]),
		) as Partial<TState>;
		return {
			state: {...state, ...changes},
			inverse: createProjectCommand({
				type: command.type,
				payload: {changes: previous} satisfies StatePatch<TState>,
				transactionId: command.transactionId,
				mergeKey: command.mergeKey,
			}),
		};
	},
});

export const createEditorCommandBus = (): CommandBus<UndoableState> => {
	const bus = new CommandBus<UndoableState>();
	for (const type of MVP_PROJECT_COMMAND_TYPES) {
		bus.register(type, patchHandler<UndoableState>());
	}
	return bus;
};

export const diffUndoableState = (
	before: UndoableState,
	after: UndoableState,
): StatePatch<UndoableState> => {
	const changes: Partial<UndoableState> = {};
	for (const key of Object.keys(after) as (keyof UndoableState)[]) {
		if (before[key] !== after[key]) {
			(changes as Record<keyof UndoableState, unknown>)[key] = after[key];
		}
	}
	return {changes};
};

export const inferCommandType = (
	before: UndoableState,
	after: UndoableState,
): MvpProjectCommandType => {
	if (before.propertyGraph !== after.propertyGraph) return 'property.update';
	if (before.shots !== after.shots) return 'shot.edit';
	if (before.assets !== after.assets) return 'asset.add';
	if (before.tracks !== after.tracks && before.items === after.items)
		return 'track.update';
	if (before.items !== after.items) return 'item.update';
	if (before.advanced !== after.advanced) return 'layer-package.import';
	return 'project.restore';
};

export const createStateTransitionCommand = ({
	before,
	after,
	type = inferCommandType(before, after),
	mergeKey,
	transactionId,
	createdAt,
}: {
	before: UndoableState;
	after: UndoableState;
	type?: MvpProjectCommandType;
	mergeKey?: string;
	transactionId?: string;
	createdAt?: string;
}): ProjectCommand<StatePatch<UndoableState>> =>
	createProjectCommand({
		type,
		payload: diffUndoableState(before, after),
		mergeKey,
		transactionId,
		createdAt,
	});
