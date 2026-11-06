import {describe, expect, it} from 'vitest';
import type {UndoableState} from '../state/types';
import {
	CommandValidationError,
	createEditorCommandBus,
	createStateTransitionCommand,
} from './command-bus';
import {COMMAND_MERGE_WINDOW_MS, CommandHistory} from './command-history';
import {createProjectCommand, MVP_PROJECT_COMMAND_TYPES} from './types';

const project = (): UndoableState => ({
	tracks: [],
	assets: {},
	items: {},
	fps: 30,
	compositionWidth: 1080,
	compositionHeight: 1920,
	deletedAssets: [],
	shots: [],
});

describe('CommandBus', () => {
	it('applies every MVP command type and creates an inverse', () => {
		const bus = createEditorCommandBus();
		for (const [index, type] of MVP_PROJECT_COMMAND_TYPES.entries()) {
			const before = project();
			const command = createProjectCommand({
				type,
				payload: {changes: {fps: 31 + index}},
			});
			const applied = bus.execute(before, command);
			expect(applied.state.fps).toBe(31 + index);
			expect(bus.execute(applied.state, applied.inverse).state).toEqual(before);
		}
	});

	it('commits a transaction atomically when all commands validate', () => {
		const bus = createEditorCommandBus();
		const before = project();
		const result = bus.executeTransaction(before, [
			createProjectCommand({
				type: 'track.update',
				payload: {
					changes: {
						tracks: [{id: 'track-1', items: [], hidden: false, muted: false}],
					},
				},
			}),
			createProjectCommand({
				type: 'project.restore',
				payload: {changes: {fps: 24}},
			}),
		]);
		expect(result.state.fps).toBe(24);
		expect(result.state.tracks).toHaveLength(1);
		expect(
			new Set(result.commands.map((command) => command.transactionId)).size,
		).toBe(1);

		const invalid = createProjectCommand({
			type: 'layer-package.import',
			payload: {changes: {}},
		});
		expect(() =>
			bus.executeTransaction(before, [result.commands[0]!, invalid]),
		).toThrow(CommandValidationError);
		expect(before).toEqual(project());
	});
});

describe('CommandHistory', () => {
	it('undoes, redoes, merges by mergeKey, and clears a redo branch', () => {
		let now = 1_000;
		const bus = createEditorCommandBus();
		const history = new CommandHistory(bus, {now: () => now});
		const initial = project();
		const firstState = {...initial, fps: 24};
		let current = history.execute(
			initial,
			createStateTransitionCommand({
				before: initial,
				after: firstState,
				type: 'project.restore',
				mergeKey: 'fps',
			}),
		).state;
		now += COMMAND_MERGE_WINDOW_MS;
		const secondState = {...current, fps: 25};
		current = history.execute(
			current,
			createStateTransitionCommand({
				before: current,
				after: secondState,
				type: 'project.restore',
				mergeKey: 'fps',
			}),
		).state;
		now += 1;
		const thirdState = {...current, compositionWidth: 720};
		current = history.execute(
			current,
			createStateTransitionCommand({
				before: current,
				after: thirdState,
				type: 'project.restore',
				mergeKey: 'fps',
			}),
		).state;

		const undone = history.undo(current);
		expect(undone.state.fps).toBe(30);
		expect(undone.state.compositionWidth).toBe(1080);
		expect(history.canUndo()).toBe(false);
		expect(history.canRedo()).toBe(true);
		const redone = history.redo(undone.state);
		expect(redone.state.fps).toBe(25);
		expect(redone.state.compositionWidth).toBe(720);

		const back = history.undo(redone.state).state;
		now += COMMAND_MERGE_WINDOW_MS + 1;
		history.execute(
			back,
			createStateTransitionCommand({
				before: back,
				after: {...back, compositionWidth: 720},
				type: 'project.restore',
			}),
		);
		expect(history.canRedo()).toBe(false);
	});

	it('keeps at most 100 committed commands', () => {
		const history = new CommandHistory(createEditorCommandBus());
		let current = project();
		for (let fps = 31; fps <= 131; fps++) {
			const next = {...current, fps};
			current = history.execute(
				current,
				createStateTransitionCommand({
					before: current,
					after: next,
					type: 'project.restore',
				}),
			).state;
		}
		for (let count = 0; count < 100; count++) {
			current = history.undo(current).state;
		}
		expect(current.fps).toBe(31);
		expect(history.canUndo()).toBe(false);
	});

	it('records a drag preview as one command at pointerup', () => {
		const history = new CommandHistory(createEditorCommandBus());
		const initial = project();
		const preview1 = {...initial, compositionWidth: 1000};
		const preview2 = {...preview1, compositionWidth: 900};
		const committed = history.execute(
			initial,
			createStateTransitionCommand({
				before: initial,
				after: preview2,
				type: 'item.update',
			}),
		).state;
		expect(committed.compositionWidth).toBe(900);
		expect(history.undo(committed).state).toEqual(initial);
		expect(history.canUndo()).toBe(false);
	});
});
