import {useCallback, useRef, useSyncExternalStore} from 'react';
import {
	createEditorCommandBus,
	createStateTransitionCommand,
	diffUndoableState,
} from '../commands/command-bus';
import {CommandHistory} from '../commands/command-history';
import type {MvpProjectCommandType, ProjectCommand} from '../commands/types';
import type {EditorState, UndoableState} from '../state/types';
import {filterSelectedItemstoOnlyReturnExistingItems} from './filter-selected-items-for-only-existing-items';

const onServer = () => false;

export type CommandCommitOptions = {
	type?: MvpProjectCommandType;
	mergeKey?: string;
	transactionId?: string;
};

export const useUndoRedo = (
	setState: React.Dispatch<React.SetStateAction<EditorState>>,
	stateRef: React.RefObject<EditorState>,
	onProjectCommit: () => void,
) => {
	const historyRef = useRef<CommandHistory<UndoableState> | null>(null);
	if (!historyRef.current) {
		historyRef.current = new CommandHistory(createEditorCommandBus());
	}
	const history = historyRef.current;
	const transientStartRef = useRef<UndoableState | null>(null);

	const noteTransientUpdate = useCallback(
		(before: UndoableState, after: UndoableState) => {
			if (
				Object.keys(diffUndoableState(before, after).changes).length > 0 &&
				transientStartRef.current === null
			) {
				transientStartRef.current = before;
			}
		},
		[],
	);

	const commitTransition = useCallback(
		(
			before: UndoableState,
			after: UndoableState,
			options: CommandCommitOptions = {},
		): boolean => {
			const start = transientStartRef.current ?? before;
			transientStartRef.current = null;
			if (Object.keys(diffUndoableState(start, after).changes).length === 0) {
				return false;
			}
			const command = createStateTransitionCommand({
				before: start,
				after,
				...options,
			});
			history.execute(start, command);
			onProjectCommit();
			return true;
		},
		[history, onProjectCommit],
	);

	const cancelTransient = useCallback(() => {
		transientStartRef.current = null;
	}, []);

	const dispatchCommand = useCallback(
		(command: ProjectCommand) => {
			cancelTransient();
			const current = stateRef.current;
			const result = history.execute(current.undoableState, command);
			setState((previous) => ({
				...previous,
				undoableState: result.state,
			}));
			onProjectCommit();
		},
		[cancelTransient, history, onProjectCommit, setState, stateRef],
	);

	const dispatchTransaction = useCallback(
		(commands: readonly ProjectCommand[], transactionId?: string) => {
			if (commands.length === 0) return;
			cancelTransient();
			const current = stateRef.current;
			const result = history.executeTransaction(
				current.undoableState,
				commands,
				transactionId,
			);
			setState((previous) => ({
				...previous,
				undoableState: result.state,
			}));
			onProjectCommit();
		},
		[cancelTransient, history, onProjectCommit, setState, stateRef],
	);

	const undo = useCallback(() => {
		cancelTransient();
		const current = stateRef.current;
		const result = history.undo(current.undoableState);
		if (result.commandCount === 0) return;
		setState((previous) => ({
			...previous,
			undoableState: result.state,
			selectedItems: filterSelectedItemstoOnlyReturnExistingItems({
				selectedItems: previous.selectedItems,
				items: result.state.items,
			}),
		}));
		onProjectCommit();
	}, [cancelTransient, history, onProjectCommit, setState, stateRef]);

	const redo = useCallback(() => {
		cancelTransient();
		const current = stateRef.current;
		const result = history.redo(current.undoableState);
		if (result.commandCount === 0) return;
		setState((previous) => ({
			...previous,
			undoableState: result.state,
			selectedItems: filterSelectedItemstoOnlyReturnExistingItems({
				selectedItems: previous.selectedItems,
				items: result.state.items,
			}),
		}));
		onProjectCommit();
	}, [cancelTransient, history, onProjectCommit, setState, stateRef]);

	const canRedo = useSyncExternalStore(
		history.subscribe,
		history.canRedo,
		onServer,
	);

	const canUndo = useSyncExternalStore(
		history.subscribe,
		history.canUndo,
		onServer,
	);

	const clearHistory = useCallback(() => {
		cancelTransient();
		history.clear();
	}, [cancelTransient, history]);

	return {
		undo,
		redo,
		canUndo,
		canRedo,
		noteTransientUpdate,
		commitTransition,
		cancelTransient,
		clearHistory,
		dispatchCommand,
		dispatchTransaction,
	};
};
