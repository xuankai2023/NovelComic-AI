import type {PlayerRef} from '@remotion/player';
import {ChevronLeft, ChevronRight, Plus, Trash2} from 'lucide-react';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {toast} from 'sonner';
import type {Shot} from '../comic/types';
import {scrollbarStyle} from '../constants';
import type {UndoableState} from '../state/types';
import {
	useFps,
	useFullState,
	useSelectedItems,
	useWriteContext,
} from '../utils/use-context';
import {
	createShotFromPanel,
	deleteShotFromPanel,
	updateShotFromPanel,
} from './shot-panel-actions';

type ShotDraft = {
	name: string;
	startFrame: string;
	durationInFrames: string;
	transitionType: 'cut' | 'crossfade';
	crossfadeDurationInFrames: string;
};

const draftFromShot = (shot: Shot): ShotDraft => {
	return {
		name: shot.name,
		startFrame: String(shot.from),
		durationInFrames: String(shot.durationInFrames),
		transitionType:
			shot.transitionOut?.type === 'crossfade' ? 'crossfade' : 'cut',
		crossfadeDurationInFrames: String(
			shot.transitionOut?.type === 'crossfade'
				? shot.transitionOut.durationInFrames
				: Math.min(12, Math.max(1, shot.durationInFrames - 1)),
		),
	};
};

const parsePositiveInteger = (value: string, fallback: number): number => {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		return fallback;
	}

	return parsed;
};

const parseNonNegativeInteger = (value: string, fallback: number): number => {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		return fallback;
	}

	return parsed;
};

const formatSeconds = (frames: number, fps: number): string => {
	if (!Number.isFinite(fps) || fps <= 0) {
		return `${frames}f`;
	}

	return `${(frames / fps).toFixed(2)}s`;
};

const stopShortcutPropagation = (
	event: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
) => {
	event.stopPropagation();
};

export const ShotPanel: React.FC<{
	playerRef: React.RefObject<PlayerRef | null>;
}> = ({playerRef}) => {
	const {selectedItems} = useSelectedItems();
	const state = useFullState();
	const {setState} = useWriteContext();
	const {fps} = useFps();
	const shots = useMemo(
		() => state.undoableState.shots ?? [],
		[state.undoableState.shots],
	);
	const [drafts, setDrafts] = useState<Record<string, ShotDraft>>({});
	const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
		null,
	);
	const [isCollapsed, setIsCollapsed] = useState(false);

	useEffect(() => {
		setDrafts((previous) => {
			const next: Record<string, ShotDraft> = {};
			for (const shot of shots) {
				next[shot.id] = previous[shot.id] ?? draftFromShot(shot);
			}
			return next;
		});
	}, [shots]);

	const selectedSingleItem = selectedItems.length === 1;

	const totalDuration = useMemo(() => {
		return shots.reduce((max, shot) => {
			return Math.max(max, shot.from + shot.durationInFrames);
		}, 0);
	}, [shots]);

	const updateDraft = useCallback(
		(shotId: string, patch: Partial<ShotDraft>) => {
			setDrafts((previous) => ({
				...previous,
				[shotId]: {
					...(previous[shotId] ?? {
						name: '',
						startFrame: '0',
						durationInFrames: String(Math.max(1, Math.round(fps * 5))),
						transitionType: 'cut',
						crossfadeDurationInFrames: '12',
					}),
					...patch,
				},
			}));
		},
		[fps],
	);

	const runProjectUpdate = useCallback(
		(
			label: string,
			type: 'shot.upsert' | 'shot.edit' | 'shot.delete',
			updater: (project: UndoableState) => UndoableState,
		) => {
			try {
				setState({
					update: (previous) => {
						return {
							...previous,
							undoableState: updater(previous.undoableState),
						};
					},
					commitToUndoStack: true,
					command: {type},
				});
			} catch (error) {
				toast.error(error instanceof Error ? error.message : `${label} failed`);
			}
		},
		[setState],
	);

	const addShot = useCallback(() => {
		runProjectUpdate('Create shot', 'shot.upsert', (project) => {
			return createShotFromPanel({
				project,
				fps,
				currentFrame: playerRef.current?.getCurrentFrame() ?? totalDuration,
			});
		});
	}, [fps, playerRef, runProjectUpdate, totalDuration]);

	const saveShot = useCallback(
		(shot: Shot, index: number) => {
			const draft = drafts[shot.id] ?? draftFromShot(shot);
			const durationInFrames = parsePositiveInteger(
				draft.durationInFrames,
				shot.durationInFrames,
			);
			const startFrame =
				index === 0
					? parseNonNegativeInteger(draft.startFrame, shot.from)
					: undefined;
			const crossfadeDuration = Math.min(
				durationInFrames - 1,
				parsePositiveInteger(
					draft.crossfadeDurationInFrames,
					shot.transitionOut?.type === 'crossfade'
						? shot.transitionOut.durationInFrames
						: 12,
				),
			);

			runProjectUpdate('Save shot', 'shot.edit', (project) => {
				return updateShotFromPanel({
					project,
					shotId: shot.id,
					name: draft.name.trim() || shot.id,
					durationInFrames,
					startFrame,
					transitionOut:
						draft.transitionType === 'crossfade' && index < shots.length - 1
							? {type: 'crossfade', durationInFrames: crossfadeDuration}
							: {type: 'cut'},
				});
			});
		},
		[drafts, runProjectUpdate, shots.length],
	);

	const deleteShot = useCallback(
		(shotId: string) => {
			runProjectUpdate('Delete shot', 'shot.delete', (project) => {
				return deleteShotFromPanel(project, shotId);
			});
			setConfirmingDeleteId(null);
		},
		[runProjectUpdate],
	);

	const seekToShot = useCallback(
		(shot: Shot) => {
			playerRef.current?.seekTo(shot.from);
		},
		[playerRef],
	);

	if (selectedSingleItem) {
		return null;
	}

	if (isCollapsed) {
		return (
			<div className="ae-shot-panel-collapsed pointer-events-none absolute top-0 right-0 bottom-0 z-30 flex items-center">
				<button
					type="button"
					className="border-editor-starter-surface-separator bg-editor-starter-panel text-editor-starter-text hover:bg-editor-starter-surface-hover pointer-events-auto flex h-12 w-7 items-center justify-center rounded-l-md border border-r-0 shadow-[0_10px_30px_var(--color-editor-starter-popover-shadow)]"
					onClick={() => setIsCollapsed(false)}
					title="展开分镜"
					aria-label="展开分镜"
				>
					<ChevronLeft className="size-4" />
				</button>
			</div>
		);
	}

	return (
		<div className="ae-shot-panel pointer-events-none absolute top-0 right-0 bottom-0 z-30 flex items-stretch justify-end">
			<div className="border-l-editor-starter-surface-separator bg-editor-starter-panel text-editor-starter-text pointer-events-auto flex h-full w-[360px] flex-col border-l shadow-[0_24px_60px_var(--color-editor-starter-popover-shadow)]">
				<div className="flex shrink-0 items-center justify-between gap-3 p-4">
					<div className="min-w-0">
						<div className="text-[16px] font-semibold tracking-tight">分镜</div>
						<div className="text-editor-starter-text-faint mt-1 text-xs">
							{shots.length} shots · {formatSeconds(totalDuration, fps)}
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-1">
						<button
							type="button"
							className="text-editor-starter-text-muted hover:bg-editor-starter-surface-hover hover:text-editor-starter-text flex h-8 w-8 items-center justify-center rounded-[4px]"
							onClick={() => setIsCollapsed(true)}
							title="收起分镜"
							aria-label="收起分镜"
						>
							<ChevronRight className="size-4" />
						</button>
						<button
							type="button"
							className="bg-editor-starter-accent text-editor-starter-on-accent flex h-8 shrink-0 items-center gap-1 rounded-[4px] px-2 text-xs font-semibold hover:opacity-90"
							onClick={addShot}
						>
							<Plus className="size-4" />
							新建
						</button>
					</div>
				</div>
				<div className="bg-editor-starter-surface-separator h-px w-full shrink-0" />
				<div
					className="min-h-0 flex-1 overflow-y-auto p-3"
					style={scrollbarStyle}
				>
					{shots.length === 0 ? (
						<div className="border-editor-starter-border text-editor-starter-text-muted rounded-[6px] border border-dashed p-4 text-sm leading-6">
							暂无分镜。点击“新建”会从当前播放帧创建第一个 shot。
						</div>
					) : (
						<div className="flex flex-col gap-3">
							{shots.map((shot, index) => {
								const draft = drafts[shot.id] ?? draftFromShot(shot);
								const isLast = index === shots.length - 1;
								return (
									<div
										key={shot.id}
										className="border-editor-starter-border bg-editor-starter-surface rounded-[6px] border p-3"
									>
										<div className="mb-3 flex items-start justify-between gap-2">
											<div className="min-w-0">
												<div className="text-editor-starter-text-faint text-[10px] font-semibold tracking-[0.08em] uppercase">
													Shot {index + 1}
												</div>
												<div
													className="text-editor-starter-text-muted mt-1 truncate text-xs"
													title={shot.id}
												>
													{shot.id}
												</div>
											</div>
											<button
												type="button"
												className="text-editor-starter-text-muted hover:bg-editor-starter-surface-hover hover:text-editor-starter-text rounded-[4px] px-2 py-1 text-xs"
												onClick={() => seekToShot(shot)}
											>
												跳转
											</button>
										</div>
										<label className="mb-2 block">
											<span className="text-editor-starter-text-faint mb-1 block text-[11px] font-semibold">
												名称
											</span>
											<input
												className="editor-starter-field w-full px-2 py-2 text-xs"
												value={draft.name}
												onChange={(event) =>
													updateDraft(shot.id, {name: event.target.value})
												}
												onKeyDown={stopShortcutPropagation}
											/>
										</label>
										<div className="grid grid-cols-2 gap-2">
											<label>
												<span className="text-editor-starter-text-faint mb-1 block text-[11px] font-semibold">
													起始帧
												</span>
												<input
													className="editor-starter-field w-full px-2 py-2 text-xs disabled:opacity-60"
													value={draft.startFrame}
													disabled={index !== 0}
													onChange={(event) =>
														updateDraft(shot.id, {
															startFrame: event.target.value,
														})
													}
													onKeyDown={stopShortcutPropagation}
												/>
											</label>
											<label>
												<span className="text-editor-starter-text-faint mb-1 block text-[11px] font-semibold">
													时长帧
												</span>
												<input
													className="editor-starter-field w-full px-2 py-2 text-xs"
													value={draft.durationInFrames}
													onChange={(event) =>
														updateDraft(shot.id, {
															durationInFrames: event.target.value,
														})
													}
													onKeyDown={stopShortcutPropagation}
												/>
											</label>
										</div>
										<div className="mt-2 grid grid-cols-2 gap-2">
											<label>
												<span className="text-editor-starter-text-faint mb-1 block text-[11px] font-semibold">
													转场
												</span>
												<select
													className="editor-starter-field w-full px-2 py-2 text-xs disabled:opacity-60"
													value={isLast ? 'cut' : draft.transitionType}
													disabled={isLast}
													onChange={(event) =>
														updateDraft(shot.id, {
															transitionType: event.target.value as
																| 'cut'
																| 'crossfade',
														})
													}
													onKeyDown={stopShortcutPropagation}
												>
													<option value="cut">cut</option>
													<option value="crossfade">crossfade</option>
												</select>
											</label>
											<label>
												<span className="text-editor-starter-text-faint mb-1 block text-[11px] font-semibold">
													交叉帧
												</span>
												<input
													className="editor-starter-field w-full px-2 py-2 text-xs disabled:opacity-60"
													value={draft.crossfadeDurationInFrames}
													disabled={
														isLast || draft.transitionType !== 'crossfade'
													}
													onChange={(event) =>
														updateDraft(shot.id, {
															crossfadeDurationInFrames: event.target.value,
														})
													}
													onKeyDown={stopShortcutPropagation}
												/>
											</label>
										</div>
										<div className="text-editor-starter-text-faint mt-2 text-[11px]">
											图层 {shot.layerTrackIds.length} · 对白{' '}
											{shot.dialogueItemIds.length} ·{' '}
											{formatSeconds(shot.durationInFrames, fps)}
										</div>
										<div className="mt-3 flex items-center justify-between gap-2">
											<button
												type="button"
												className="bg-editor-starter-surface-hover hover:bg-editor-starter-surface-active text-editor-starter-text rounded-[4px] px-3 py-1.5 text-xs font-semibold"
												onClick={() => saveShot(shot, index)}
											>
												保存
											</button>
											{confirmingDeleteId === shot.id ? (
												<div className="flex gap-1">
													<button
														type="button"
														className="text-editor-starter-text-muted hover:bg-editor-starter-surface-hover rounded-[4px] px-2 py-1.5 text-xs"
														onClick={() => setConfirmingDeleteId(null)}
													>
														取消
													</button>
													<button
														type="button"
														className="rounded-[4px] bg-red-500/90 px-2 py-1.5 text-xs font-semibold text-white hover:bg-red-500"
														onClick={() => deleteShot(shot.id)}
													>
														确认删除
													</button>
												</div>
											) : (
												<button
													type="button"
													className="text-editor-starter-text-muted flex items-center gap-1 rounded-[4px] px-2 py-1.5 text-xs hover:bg-red-500/10 hover:text-red-300"
													onClick={() => setConfirmingDeleteId(shot.id)}
												>
													<Trash2 className="size-3.5" />
													删除
												</button>
											)}
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
