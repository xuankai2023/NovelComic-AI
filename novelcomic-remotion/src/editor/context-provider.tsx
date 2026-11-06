'use client';

import React, {
	createContext,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {AssetState, EditorStarterAsset} from './assets/assets';
import {CanvasSnapPoint} from './canvas/snap/canvas-snap-types';
import {CaptioningTask} from './captioning/caption-state';
import type {Shot} from './comic/types';
import type {ProjectCommand} from './commands/types';
import {
	createEmptyAdvancedProjectState,
	type AdvancedProjectState,
} from './composition/types';
import {EditModeProvider} from './edit-mode';
import {EditorStarterItem} from './items/item-type';
import {TextItemHoverPreview} from './items/text/override-text-item-with-hover-preview';
import {ItemBeingTrimmed} from './items/trim-indicator';
import {ProjectContextProvider} from './project/project-context';
import {RenderingTask} from './rendering/render-state';
import {loadAutoKeyEnabled} from './state/auto-key-persistance';
import {getInitialState} from './state/initial-state';
import {loadStateFromLocaleSwitch} from './state/locale-switch-state';
import {loadLoop} from './state/loop-persistance';
import {loadSnappingEnabled} from './state/snapping-persistance';
import {
	DEFAULT_TIMELINE_HEIGHT,
	loadTimelineHeight,
} from './state/timeline-height-persistance';
import {EditorState, TrackType} from './state/types';
import {DragPreviewProvider} from './timeline/drag-preview-provider';
import {SnapPoint} from './timeline/utils/snap-points';
import {getCompositionDuration} from './utils/get-composition-duration';
import {TimelineZoomProvider} from './utils/timeline-zoom-provider';
import {useUndoRedo, type CommandCommitOptions} from './utils/undo-redo';

export type SetState = (options: {
	update: EditorState | ((state: EditorState) => EditorState);
	commitToUndoStack: boolean;
	command?: CommandCommitOptions;
	cancelTransient?: boolean;
}) => void;

export type TimelineWriteOnlyContext = {
	setState: SetState;
	undo: () => void;
	redo: () => void;
	dispatchCommand: (command: ProjectCommand) => void;
	dispatchTransaction: (
		commands: readonly ProjectCommand[],
		transactionId?: string,
	) => void;
};

export interface TimelineContext {
	durationInFrames: number;
}

export interface TracksContext {
	tracks: TrackType[];
}

export interface ShotsContext {
	shots: Shot[];
}

export interface AdvancedProjectContext {
	advanced: AdvancedProjectState;
}

export interface FpsContext {
	fps: number;
}

export interface DimensionsContext {
	compositionWidth: number;
	compositionHeight: number;
}

export interface SelectedItemsContext {
	selectedItems: string[];
}

export interface AssetsContext {
	assets: Record<string, EditorStarterAsset>;
}

export interface AssetStatusContext {
	assetStatus: Record<string, AssetState>;
}

export interface CanUseUndoStackContext {
	canUndo: boolean;
	canRedo: boolean;
}

export interface CurrentStateContext {
	state: React.RefObject<EditorState>;
}

export interface AllItemsContext {
	items: Record<string, EditorStarterItem>;
}

export interface ActiveTimelineSnap {
	activeSnapPoint: SnapPoint | null;
}

export interface ActiveCanvasSnap {
	activeCanvasSnapPoints: CanvasSnapPoint[];
}

export const TimelineContext = createContext<TimelineContext | null>(null);
export const TimelineWriteOnlyContext =
	createContext<TimelineWriteOnlyContext | null>(null);
export const RenderingContext = createContext<RenderingTask[] | null>(null);
export const FpsContext = createContext<FpsContext | null>(null);
export const DimensionsContext = createContext<DimensionsContext | null>(null);
export const SelectedItemsContext = createContext<SelectedItemsContext | null>(
	null,
);
export const AssetsContext = createContext<AssetsContext | null>(null);
export const AssetStatusContext = createContext<AssetStatusContext | null>(
	null,
);
export const TracksContext = createContext<TracksContext | null>(null);
export const ShotsContext = createContext<ShotsContext | null>(null);
export const AdvancedProjectContext =
	createContext<AdvancedProjectContext | null>(null);
export const AllItemsContext = createContext<AllItemsContext | null>(null);
export const FullStateContext = createContext<EditorState | null>(null);
export const CanUseUndoStackContext =
	createContext<CanUseUndoStackContext | null>(null);
export const CurrentStateContext = createContext<CurrentStateContext | null>(
	null,
);
export const TextItemEditingContext = createContext<string | null>(null);
export const ItemSelectedForCropContext = createContext<string | null>(null);
export const TextItemHoverPreviewContext =
	createContext<TextItemHoverPreview | null>(null);
export const StateInitializedContext = createContext<boolean>(false);
export const CaptionStateContext = createContext<CaptioningTask[]>([]);
export const ItemsBeingTrimmedContext = createContext<ItemBeingTrimmed[]>([]);
export const LoopContext = createContext<boolean>(true);
export const SnappingEnabledContext = createContext<boolean | null>(null);
export const TimelineHeightContext = createContext<number>(
	DEFAULT_TIMELINE_HEIGHT,
);
export const ActiveTimelineSnapContext =
	createContext<ActiveTimelineSnap | null>(null);
export const ActiveCanvasSnapContext = createContext<ActiveCanvasSnap | null>(
	null,
);

type ContextProviderProps = {
	children: React.ReactNode;
};

export const ContextProvider = ({children}: ContextProviderProps) => {
	const [state, setStateWithoutHistory] = useState<EditorState>(() =>
		getInitialState(),
	);
	const [projectCommitRevision, setProjectCommitRevision] = useState(0);
	const hasSeenUndoableStateRef = useRef(false);
	const authorizedProjectStateRef = useRef(state.undoableState);
	const setAuthorizedEditorState = useCallback<
		React.Dispatch<React.SetStateAction<EditorState>>
	>((action) => {
		setStateWithoutHistory((previous) => {
			const next = typeof action === 'function' ? action(previous) : action;
			authorizedProjectStateRef.current = next.undoableState;
			return next;
		});
	}, []);

	const imperativeState = useRef(state);
	imperativeState.current = state;

	const initialize = useCallback(async () => {
		const loadedStateFromLocaleSwitch = loadStateFromLocaleSwitch();
		setAuthorizedEditorState((prev) => ({
			...prev,
			selectedItems:
				loadedStateFromLocaleSwitch?.selectedItems ?? prev.selectedItems,
			textItemEditing:
				loadedStateFromLocaleSwitch?.textItemEditing ?? prev.textItemEditing,
			itemSelectedForCrop:
				loadedStateFromLocaleSwitch?.itemSelectedForCrop ??
				prev.itemSelectedForCrop,
			undoableState:
				loadedStateFromLocaleSwitch?.undoableState ?? prev.undoableState,
			initialized: false,
			loop: loadedStateFromLocaleSwitch?.loop ?? loadLoop(),
			timelineHeight:
				loadedStateFromLocaleSwitch?.timelineHeight ?? loadTimelineHeight(),
			isSnappingEnabled:
				loadedStateFromLocaleSwitch?.isSnappingEnabled ?? loadSnappingEnabled(),
			autoKeyEnabled:
				loadedStateFromLocaleSwitch?.autoKeyEnabled ?? loadAutoKeyEnabled(),
		}));
	}, [setAuthorizedEditorState]);

	useEffect(() => {
		// eslint-disable-next-line no-console
		initialize().catch(console.error);
	}, [initialize]);

	const onProjectCommit = useCallback(() => {
		setProjectCommitRevision((revision) => revision + 1);
	}, []);
	const {
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
	} = useUndoRedo(setAuthorizedEditorState, imperativeState, onProjectCommit);

	const isItemBeingTrimmed = state.itemsBeingTrimmed.length > 0;

	const durationInFrames = useMemo(() => {
		return getCompositionDuration(Object.values(state.undoableState.items));
	}, [state.undoableState.items]);

	const lastDurationWhileNotTrimming = useRef(durationInFrames);
	if (!isItemBeingTrimmed) {
		lastDurationWhileNotTrimming.current = durationInFrames;
	}

	const setStateWithPossibleStrictModeDoubleTrigger: SetState = useCallback(
		({update, commitToUndoStack, command, cancelTransient: cancel}) => {
			const previous = imperativeState.current;
			const newState =
				typeof update === 'function' ? update(previous) : update;

			if (commitToUndoStack) {
				commitTransition(
					previous.undoableState,
					newState.undoableState,
					command,
				);
			} else {
				noteTransientUpdate(previous.undoableState, newState.undoableState);
			}
			if (cancel) cancelTransient();

			if (newState === previous) return;

			// Keep imperative callers in sync until React commits the state update.
			imperativeState.current = newState;
			setAuthorizedEditorState(newState);
		},
		[
			cancelTransient,
			commitTransition,
			noteTransientUpdate,
			setAuthorizedEditorState,
		],
	);

	useEffect(() => {
		if (
			process.env.NODE_ENV !== 'production' &&
			authorizedProjectStateRef.current !== state.undoableState
		) {
			throw new Error(
				'Project content changed outside the Command Bus or project hydration boundary.',
			);
		}
	}, [state.undoableState]);

	const setState: SetState = useCallback(
		({update, commitToUndoStack, command, cancelTransient: cancel}) => {
			// The undo stack checks if the state was changed by reference.
			// If we have an action that changes the state and commits to the undo stack,
			// it could mutate the state twice due to the strict mode double trigger.

			// To avoid it, we first mutate the state, possibly twice.
			// Then we commit the undo stack without mutating the state.

			setStateWithPossibleStrictModeDoubleTrigger({
				update,
				commitToUndoStack: false,
			});
			if (commitToUndoStack) {
				setStateWithPossibleStrictModeDoubleTrigger({
					update: (s) => s,
					commitToUndoStack: true,
					command,
				});
			} else if (cancel) {
				setStateWithPossibleStrictModeDoubleTrigger({
					update: (s) => s,
					commitToUndoStack: false,
					cancelTransient: true,
				});
			}
		},
		[setStateWithPossibleStrictModeDoubleTrigger],
	);

	const readContext = useMemo(
		(): TimelineContext => ({
			// We only re-draw the timeline once the trimming is done.
			durationInFrames: lastDurationWhileNotTrimming.current,
		}),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[lastDurationWhileNotTrimming.current],
	);

	const fpsContext = useMemo(
		(): FpsContext => ({
			fps: state.undoableState.fps,
		}),
		[state.undoableState.fps],
	);

	const dimensionsContext = useMemo(
		(): DimensionsContext => ({
			compositionWidth: state.undoableState.compositionWidth,
			compositionHeight: state.undoableState.compositionHeight,
		}),
		[
			state.undoableState.compositionWidth,
			state.undoableState.compositionHeight,
		],
	);

	const selectedItemsContext = useMemo(
		(): SelectedItemsContext => ({
			selectedItems: state.selectedItems,
		}),
		[state.selectedItems],
	);

	const assetsContext = useMemo(
		(): AssetsContext => ({
			assets: state.undoableState.assets,
		}),
		[state.undoableState.assets],
	);

	const assetStatusContext = useMemo(
		(): AssetStatusContext => ({
			assetStatus: state.assetStatus,
		}),
		[state.assetStatus],
	);

	const tracksContext = useMemo(
		(): TracksContext => ({
			tracks: state.undoableState.tracks,
		}),
		[state.undoableState.tracks],
	);

	const shotsContext = useMemo(
		(): ShotsContext => ({
			shots: state.undoableState.shots ?? [],
		}),
		[state.undoableState.shots],
	);

	const advancedProjectContext = useMemo(
		(): AdvancedProjectContext => ({
			advanced:
				state.undoableState.advanced ??
				createEmptyAdvancedProjectState(
					state.undoableState.compositionWidth,
					state.undoableState.compositionHeight,
					state.undoableState.fps,
				),
		}),
		[
			state.undoableState.advanced,
			state.undoableState.compositionHeight,
			state.undoableState.compositionWidth,
			state.undoableState.fps,
		],
	);

	const writeContext = useMemo(
		(): TimelineWriteOnlyContext => ({
			setState,
			undo,
			redo,
			dispatchCommand,
			dispatchTransaction,
		}),
		[setState, undo, redo, dispatchCommand, dispatchTransaction],
	);

	const canUseUndoStackContext = useMemo(
		(): CanUseUndoStackContext => ({
			canUndo,
			canRedo,
		}),
		[canUndo, canRedo],
	);

	const currentStateContext = useMemo(
		(): CurrentStateContext => ({
			state: imperativeState,
		}),
		[imperativeState],
	);

	const allItemsContext = useMemo(
		(): AllItemsContext => ({
			items: state.undoableState.items,
		}),
		[state.undoableState.items],
	);

	const textItemHoverPreviewContext = useMemo(
		(): TextItemHoverPreview | null => state.textItemHoverPreview,
		[state.textItemHoverPreview],
	);

	const renderingContext = useMemo(
		(): RenderingTask[] => state.renderingTasks,
		[state.renderingTasks],
	);

	const captionStateContext = useMemo(
		(): CaptioningTask[] => state.captioningTasks,
		[state.captioningTasks],
	);

	const itemsBeingTrimmedContext = useMemo(
		(): ItemBeingTrimmed[] => state.itemsBeingTrimmed,
		[state.itemsBeingTrimmed],
	);

	const activeTimelineSnapContext = useMemo(
		(): ActiveTimelineSnap => ({
			activeSnapPoint: state.activeSnapPoint,
		}),
		[state.activeSnapPoint],
	);

	const activeCanvasSnapContext = useMemo(
		(): ActiveCanvasSnap => ({
			activeCanvasSnapPoints: state.activeCanvasSnapPoints,
		}),
		[state.activeCanvasSnapPoints],
	);

	useEffect(() => {
		if (!state.initialized) {
			return;
		}

		if (!hasSeenUndoableStateRef.current) {
			hasSeenUndoableStateRef.current = true;
			return;
		}

		// eslint-disable-next-line no-console
		console.log(
			'[editor-starter] undoableState',
			JSON.stringify(state.undoableState, null, 2),
		);
	}, [state.initialized, state.undoableState]);

	// Why there is such a deeply nested context provider:
	// https://remotion.dev/docs/editor-starter/state-management#contexts
	return (
		<TimelineContext.Provider value={readContext}>
			<TimelineWriteOnlyContext.Provider value={writeContext}>
				<FpsContext.Provider value={fpsContext}>
					<DimensionsContext.Provider value={dimensionsContext}>
						<SelectedItemsContext.Provider value={selectedItemsContext}>
							<AssetsContext.Provider value={assetsContext}>
								<AssetStatusContext.Provider value={assetStatusContext}>
									<TracksContext.Provider value={tracksContext}>
										<ShotsContext.Provider value={shotsContext}>
											<AdvancedProjectContext.Provider
												value={advancedProjectContext}
											>
												<FullStateContext.Provider value={state}>
													<CanUseUndoStackContext.Provider
														value={canUseUndoStackContext}
													>
														<CurrentStateContext.Provider
															value={currentStateContext}
														>
															<AllItemsContext.Provider value={allItemsContext}>
																<TextItemEditingContext.Provider
																	value={state.textItemEditing}
																>
																	<ItemSelectedForCropContext.Provider
																		value={state.itemSelectedForCrop}
																	>
																		<TextItemHoverPreviewContext.Provider
																			value={textItemHoverPreviewContext}
																		>
																			<RenderingContext.Provider
																				value={renderingContext}
																			>
																				<CaptionStateContext.Provider
																					value={captionStateContext}
																				>
																					<StateInitializedContext.Provider
																						value={state.initialized}
																					>
																						<ItemsBeingTrimmedContext.Provider
																							value={itemsBeingTrimmedContext}
																						>
																							<LoopContext.Provider
																								value={state.loop}
																							>
																								<SnappingEnabledContext.Provider
																									value={
																										state.isSnappingEnabled
																									}
																								>
																									<TimelineHeightContext.Provider
																										value={state.timelineHeight}
																									>
																										<ActiveTimelineSnapContext.Provider
																											value={
																												activeTimelineSnapContext
																											}
																										>
																											<ActiveCanvasSnapContext.Provider
																												value={
																													activeCanvasSnapContext
																												}
																											>
																												<EditModeProvider>
																													<DragPreviewProvider>
																														<TimelineZoomProvider>
																															<ProjectContextProvider
																																state={state}
																																setEditorState={
																																	setAuthorizedEditorState
																																}
																																projectCommitRevision={
																																	projectCommitRevision
																																}
																																resetCommandHistory={
																																	clearHistory
																																}
																															>
																																{children}
																															</ProjectContextProvider>
																														</TimelineZoomProvider>
																													</DragPreviewProvider>
																												</EditModeProvider>
																											</ActiveCanvasSnapContext.Provider>
																										</ActiveTimelineSnapContext.Provider>
																									</TimelineHeightContext.Provider>
																								</SnappingEnabledContext.Provider>
																							</LoopContext.Provider>
																						</ItemsBeingTrimmedContext.Provider>
																					</StateInitializedContext.Provider>
																				</CaptionStateContext.Provider>
																			</RenderingContext.Provider>
																		</TextItemHoverPreviewContext.Provider>
																	</ItemSelectedForCropContext.Provider>
																</TextItemEditingContext.Provider>
															</AllItemsContext.Provider>
														</CurrentStateContext.Provider>
													</CanUseUndoStackContext.Provider>
												</FullStateContext.Provider>
											</AdvancedProjectContext.Provider>
										</ShotsContext.Provider>
									</TracksContext.Provider>
								</AssetStatusContext.Provider>
							</AssetsContext.Provider>
						</SelectedItemsContext.Provider>
					</DimensionsContext.Provider>
				</FpsContext.Provider>
			</TimelineWriteOnlyContext.Provider>
		</TimelineContext.Provider>
	);
};
