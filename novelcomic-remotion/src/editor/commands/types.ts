import type {ProjectIssue} from '../comic/types';

export const MVP_PROJECT_COMMAND_TYPES = [
	'project.rename',
	'asset.add',
	'asset.remove',
	'track.update',
	'track.reorder',
	'item.create',
	'item.update',
	'item.delete',
	'shot.upsert',
	'shot.edit',
	'shot.delete',
	'property.update',
	'sprite.update',
	'dialogue.update',
	'layer-package.import',
	'project.restore',
] as const;

export type MvpProjectCommandType = (typeof MVP_PROJECT_COMMAND_TYPES)[number];

export type ProjectCommand<TPayload = unknown> = {
	id: string;
	type: MvpProjectCommandType;
	payload: TPayload;
	transactionId?: string;
	mergeKey?: string;
	createdAt: string;
};

export type CommandApplyResult<TState> = {
	state: TState;
	inverse: ProjectCommand;
};

export type ProjectCommandHandler<TState> = {
	apply: (state: TState, command: ProjectCommand) => CommandApplyResult<TState>;
	validate: (command: ProjectCommand, state: TState) => ProjectIssue[];
};

export type AppliedProjectCommand<TState> = CommandApplyResult<TState> & {
	command: ProjectCommand;
};

export type CommandTransactionResult<TState> = {
	state: TState;
	commands: ProjectCommand[];
	inverses: ProjectCommand[];
};

export type StatePatch<TState> = {
	changes: Partial<TState>;
};

let fallbackId = 0;

export const createCommandId = (prefix = 'command'): string => {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
		return `${prefix}-${crypto.randomUUID()}`;
	}

	fallbackId += 1;
	return `${prefix}-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
};

export const createProjectCommand = <TPayload>({
	type,
	payload,
	transactionId,
	mergeKey,
	id = createCommandId(type),
	createdAt = new Date().toISOString(),
}: {
	type: MvpProjectCommandType;
	payload: TPayload;
	transactionId?: string;
	mergeKey?: string;
	id?: string;
	createdAt?: string;
}): ProjectCommand<TPayload> => ({
	id,
	type,
	payload,
	createdAt,
	...(transactionId ? {transactionId} : {}),
	...(mergeKey ? {mergeKey} : {}),
});
