'use client';

import type {PlayerRef} from '@remotion/player';
import {
	ChevronDown,
	ChevronRight,
	Eye,
	EyeOff,
	GitBranch,
	Layers,
	Lock,
	Unlock,
} from 'lucide-react';
import {useTranslations} from 'next-intl';
import React, {useMemo, useState} from 'react';
import {toast} from 'sonner';
import {parseExpression} from '../advanced/expressions';
import {
	createAdvancedLayerFromItem,
	createAdvancedPrecompose,
	setAdvancedLayerLock,
	setAdvancedLayerMasks,
	setAdvancedLayerMatte,
	setAdvancedLayerParent,
	setAdvancedLayerVisibility,
	updateAdvancedLayerTransform,
} from '../composition/advanced-actions';
import {flattenPrecompose} from '../composition/precompose';
import {
	createEmptyAdvancedProjectState,
	type AdvancedProjectState,
	type AdvancedTransform,
	type ExpressionProperty,
	type LayerNode,
	type MaskDefinition,
	type TrackMatteDefinition,
} from '../composition/types';
import type {EditorStarterItem} from '../items/item-type';
import {
	useAdvancedProject,
	useAllItems,
	useSelectedItems,
	useTimelineContext,
	useWriteContext,
} from '../utils/use-context';

const cloneAdvancedWithRootDuration = (
	state: AdvancedProjectState,
	durationInFrames: number,
): AdvancedProjectState => {
	const root = state.compositions[state.rootCompositionId];
	if (!root || root.durationInFrames === durationInFrames) {
		return state;
	}

	return {
		...state,
		compositions: {
			...state.compositions,
			[state.rootCompositionId]: {
				...root,
				durationInFrames: Math.max(1, durationInFrames),
			},
		},
	};
};

const getItemTransform = (item: EditorStarterItem): AdvancedTransform => ({
	x: item.left,
	y: item.top,
	width: item.width,
	height: item.height,
	scaleX: 1,
	scaleY: 1,
	rotation: 'rotation' in item ? item.rotation : 0,
	opacity: item.opacity,
	anchorX: 0.5,
	anchorY: 0.5,
});

const getLayerForItem = (
	state: AdvancedProjectState,
	itemId: string,
): LayerNode | undefined =>
	Object.values(state.layers).find((layer) => layer.itemId === itemId);

const getNextLayerId = (
	state: AdvancedProjectState,
	itemId: string,
): string => {
	const base = `advanced:${itemId}`;
	if (!state.layers[base]) {
		return base;
	}

	let suffix = 2;
	while (state.layers[`${base}:${suffix}`]) {
		suffix += 1;
	}
	return `${base}:${suffix}`;
};

const getNextCompositionId = (state: AdvancedProjectState): string => {
	let suffix = 1;
	while (state.compositions[`composition:precomp:${suffix}`]) {
		suffix += 1;
	}
	return `composition:precomp:${suffix}`;
};

const getNextWrapperId = (state: AdvancedProjectState): string => {
	let suffix = 1;
	while (state.layers[`layer:precomp:${suffix}`]) {
		suffix += 1;
	}
	return `layer:precomp:${suffix}`;
};

const NumericField: React.FC<{
	label: string;
	value: number;
	step?: number;
	disabled?: boolean;
	onCommit: (value: number) => void;
}> = ({label, value, step = 1, disabled = false, onCommit}) => {
	const [draft, setDraft] = useState(String(value));

	React.useEffect(() => {
		setDraft(String(value));
	}, [value]);

	return (
		<label className="flex min-w-0 flex-1 flex-col gap-1">
			<span className="text-[10px] text-white/45">{label}</span>
			<input
				type="number"
				step={step}
				value={draft}
				disabled={disabled}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					const next = Number(draft);
					if (Number.isFinite(next)) {
						onCommit(next);
					} else {
						setDraft(String(value));
					}
				}}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						event.currentTarget.blur();
					}
				}}
				className="h-7 w-full rounded border border-white/10 bg-black/20 px-2 text-xs text-white outline-none focus:border-white/30 disabled:cursor-not-allowed disabled:opacity-40"
			/>
		</label>
	);
};

const iconButtonClass =
	'flex size-7 items-center justify-center rounded text-white/55 transition-colors hover:bg-white/10 hover:text-white';

const hasLockedAncestor = (
	state: AdvancedProjectState,
	layer: LayerNode,
): boolean => {
	const visited = new Set<string>();
	let currentId = layer.parentId ?? null;

	while (currentId) {
		if (visited.has(currentId)) {
			return true;
		}
		visited.add(currentId);
		const parent = state.layers[currentId];
		if (!parent) {
			return false;
		}
		if (parent.locked) {
			return true;
		}
		currentId = parent.parentId ?? null;
	}

	return false;
};

export const AdvancedCompositionPanel: React.FC<{
	playerRef: React.RefObject<PlayerRef | null>;
	onClose: () => void;
}> = ({playerRef, onClose}) => {
	const t = useTranslations('editor.actionRow.advanced');
	const {selectedItems} = useSelectedItems();
	const {items} = useAllItems();
	const {advanced} = useAdvancedProject();
	const {durationInFrames} = useTimelineContext();
	const {setState} = useWriteContext();
	const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>([]);
	const [expressionProperty, setExpressionProperty] =
		useState<ExpressionProperty>('x');
	const [expressionDrafts, setExpressionDrafts] = useState<
		Record<string, string>
	>({});

	const layers = useMemo(
		() =>
			Object.values(advanced.layers).sort((left, right) => {
				if (left.compositionId !== right.compositionId) {
					return left.compositionId.localeCompare(right.compositionId);
				}
				return left.zIndex - right.zIndex;
			}),
		[advanced.layers],
	);

	const setAdvanced = (
		update: (state: AdvancedProjectState) => AdvancedProjectState,
	) => {
		try {
			setState({
				update: (state) => {
					const current =
						state.undoableState.advanced ??
						createEmptyAdvancedProjectState(
							state.undoableState.compositionWidth,
							state.undoableState.compositionHeight,
							state.undoableState.fps,
							durationInFrames,
						);
					return {
						...state,
						undoableState: {
							...state.undoableState,
							advanced: update(
								cloneAdvancedWithRootDuration(current, durationInFrames),
							),
						},
					};
				},
				commitToUndoStack: true,
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};

	const addSelectedItems = () => {
		if (selectedItems.length === 0) {
			toast.error(t('needTimelineSelection'));
			return;
		}

		setAdvanced((state) => {
			let next = state;
			for (const itemId of selectedItems) {
				const item = items[itemId];
				if (!item || getLayerForItem(next, itemId)) {
					continue;
				}
				const layerId = getNextLayerId(next, itemId);
				next = createAdvancedLayerFromItem(next, {
					layerId,
					itemId,
					name: item.type === 'image' ? itemId : `${item.type}:${itemId}`,
					transform: getItemTransform(item),
					from: item.from,
					durationInFrames: item.durationInFrames,
				});
			}
			return next;
		});
	};

	const toggleLayerSelection = (layerId: string) => {
		setSelectedLayerIds((current) =>
			current.includes(layerId)
				? current.filter((id) => id !== layerId)
				: [...current, layerId],
		);
	};

	const createPrecomposeFromSelection = () => {
		if (selectedLayerIds.length === 0) {
			toast.error(t('needSelection'));
			return;
		}

		const selected = selectedLayerIds
			.map((id) => advanced.layers[id])
			.filter((layer): layer is LayerNode => Boolean(layer));
		if (selected.length !== selectedLayerIds.length) {
			toast.error(t('needSelection'));
			return;
		}

		const compositionId = getNextCompositionId(advanced);
		const wrapperId = getNextWrapperId(advanced);
		const compositionIdForSelection = selected[0]?.compositionId;
		if (
			!compositionIdForSelection ||
			selected.some((layer) => layer.compositionId !== compositionIdForSelection)
		) {
			toast.error(t('needSelection'));
			return;
		}
		const parentComposition =
			advanced.compositions[compositionIdForSelection];
		if (!parentComposition) {
			toast.error(t('needSelection'));
			return;
		}

		setAdvanced((state) =>
			createAdvancedPrecompose(state, {
				compositionId: compositionIdForSelection,
				layerIds: selectedLayerIds,
				composition: {
					id: compositionId,
					name: `${t('precomposeName')} ${Object.keys(state.compositions).length}`,
					width: parentComposition.width,
					height: parentComposition.height,
					fps: parentComposition.fps,
					durationInFrames: parentComposition.durationInFrames,
					from: 0,
				},
				wrapper: {
					id: wrapperId,
					name: `${t('precomposeName')} ${Object.keys(state.compositions).length}`,
					zIndex: Math.min(...selected.map((layer) => layer.zIndex)),
					visible: true,
					locked: false,
					from: 0,
					durationInFrames: parentComposition.durationInFrames,
					transform: {
						x: 0,
						y: 0,
						width: parentComposition.width,
						height: parentComposition.height,
						scaleX: 1,
						scaleY: 1,
						rotation: 0,
						opacity: 1,
						anchorX: 0.5,
						anchorY: 0.5,
					},
				},
			}),
		);
		setSelectedLayerIds([wrapperId]);
	};

	const flattenSelected = () => {
		const wrapper = selectedLayerIds
			.map((id) => advanced.layers[id])
			.find((layer) => layer?.sourceCompositionId);
		if (!wrapper) {
			toast.error(t('needSelection'));
			return;
		}
		setAdvanced((state) => flattenPrecompose(state, wrapper.id));
		setSelectedLayerIds([]);
	};

	const updateTransform = (
		layerId: string,
		patch: Partial<AdvancedTransform>,
	) => {
		setAdvanced((state) => updateAdvancedLayerTransform(state, {layerId, patch}));
	};

	const setParent = (layerId: string, parentId: string | null) => {
		setAdvanced((state) =>
			setAdvancedLayerParent(state, {
				layerId,
				parentId,
				keepWorldTransform: true,
				frame: playerRef.current?.getCurrentFrame() ?? 0,
			}),
		);
	};

	const setMatte = (
		layerId: string,
		matteLayerId: string,
		type: TrackMatteDefinition['type'],
		) => {
		setAdvanced((state) =>
			setAdvancedLayerMatte(state, {
				layerId,
				matte: matteLayerId ? {layerId: matteLayerId, type} : undefined,
			}),
		);
	};

	const toggleBasicMask = (layer: LayerNode) => {
		const current = layer.masks ?? [];
		if (current.length > 0) {
			setAdvanced((state) =>
				setAdvancedLayerMasks(state, {layerId: layer.id, masks: []}),
			);
			return;
		}

		const inset = 12;
		const mask: MaskDefinition = {
			id: `mask:${layer.id}:1`,
			mode: 'add',
			inverted: false,
			feather: 0,
			expansion: 0,
			points: [
				{x: inset, y: inset},
				{x: Math.max(inset + 1, layer.transform.width - inset), y: inset},
				{
					x: Math.max(inset + 1, layer.transform.width - inset),
					y: Math.max(inset + 1, layer.transform.height - inset),
				},
				{x: inset, y: Math.max(inset + 1, layer.transform.height - inset)},
			],
		};
		setAdvanced((state) =>
			setAdvancedLayerMasks(state, {layerId: layer.id, masks: [mask]}),
		);
	};

	const expressionFor = (layer: LayerNode, property: ExpressionProperty) =>
		(layer.expressionIds ?? [])
			.map((expressionId) => advanced.expressions?.[expressionId])
			.find((expression) => expression?.property === property);

	const applyExpression = (layer: LayerNode) => {
		const key = `${layer.id}:${expressionProperty}`;
		const source =
			expressionDrafts[key]?.trim() ??
			expressionFor(layer, expressionProperty)?.source ??
			'';
		if (!source) {
			toast.error(t('expressionRequired'));
			return;
		}

		try {
			const parsed = parseExpression(source);
			setAdvanced((state) => {
				const expressionId = `expression:${layer.id}:${expressionProperty}`;
				const current = state.layers[layer.id];
				if (!current) return state;
				const previousIds = (current.expressionIds ?? []).filter(
					(id) => state.expressions?.[id]?.property !== expressionProperty,
				);
				return {
					...state,
					expressions: {
						...(state.expressions ?? {}),
						[expressionId]: {
							id: expressionId,
							property: expressionProperty,
							source,
							ast: parsed.ast,
							dependencies: parsed.dependencies,
							enabled: true,
						},
					},
					layers: {
						...state.layers,
						[layer.id]: {
							...current,
							expressionIds: [...previousIds, expressionId],
						},
					},
				};
			});
			toast.success(t('expressionApplied'));
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : t('expressionInvalid'),
			);
		}
	};

	const clearExpression = (layer: LayerNode) => {
		setAdvanced((state) => {
			const current = state.layers[layer.id];
			if (!current) return state;
			const removedIds = new Set(
				(current.expressionIds ?? []).filter(
					(id) => state.expressions?.[id]?.property === expressionProperty,
				),
			);
			const expressions = Object.fromEntries(
				Object.entries(state.expressions ?? {}).filter(
					([id]) => !removedIds.has(id),
				),
			);
			return {
				...state,
				expressions,
				layers: {
					...state.layers,
					[layer.id]: {
						...current,
						expressionIds: (current.expressionIds ?? []).filter(
							(id) => !removedIds.has(id),
						),
					},
				},
			};
		});
	};

	return (
		<div className="border-editor-starter-surface-separator bg-editor-starter-panel text-editor-starter-text pointer-events-auto absolute top-3 bottom-3 left-[66px] z-50 flex w-[370px] flex-col overflow-hidden rounded-[10px] border shadow-[0_24px_70px_var(--color-editor-starter-popover-shadow)]">
			<div className="flex shrink-0 items-center justify-between border-b border-white/5 px-3 py-2.5">
				<div className="flex items-center gap-2 text-sm font-semibold">
					<GitBranch className="size-4" />
					<span>{t('title')}</span>
				</div>
				<button
					type="button"
					className={iconButtonClass}
					onClick={onClose}
					title="Close"
					aria-label="Close"
				>
					<ChevronRight className="size-4 rotate-180" />
				</button>
			</div>

			<div className="flex shrink-0 gap-2 border-b border-white/5 p-3">
				<button
					type="button"
					className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded bg-editor-starter-accent px-2 text-xs font-semibold text-white hover:brightness-110"
					onClick={addSelectedItems}
				>
					<Layers className="size-3.5" />
					{t('addSelected')}
				</button>
				<button
					type="button"
					className="flex h-8 items-center justify-center rounded border border-white/10 px-2 text-xs text-white/75 hover:bg-white/8"
					onClick={createPrecomposeFromSelection}
					title={t('precompose')}
				>
					<GitBranch className="size-3.5" />
				</button>
				<button
					type="button"
					className="flex h-8 items-center justify-center rounded border border-white/10 px-2 text-xs text-white/75 hover:bg-white/8"
					onClick={flattenSelected}
					title={t('flatten')}
				>
					<ChevronDown className="size-3.5" />
				</button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-3">
				{layers.length === 0 ? (
					<div className="flex min-h-32 items-center justify-center text-center text-xs text-white/45">
						{t('empty')}
					</div>
				) : (
					<div className="space-y-2">
						{layers.map((layer) => {
							const item = layer.itemId ? items[layer.itemId] : undefined;
							const lockedByHierarchy =
								layer.locked || hasLockedAncestor(advanced, layer);
							const siblings = layers.filter(
								(candidate) =>
									candidate.compositionId === layer.compositionId &&
									candidate.id !== layer.id,
							);
							const checked = selectedLayerIds.includes(layer.id);
							return (
								<div
									key={layer.id}
									className={`border p-2 ${
										checked
											? 'border-editor-starter-accent/60 bg-white/8'
											: 'border-white/8 bg-black/10'
									}`}
								>
									<div className="flex items-center gap-2">
										<input
											type="checkbox"
											checked={checked}
											onChange={() => toggleLayerSelection(layer.id)}
											aria-label={layer.name}
										/>
										<div className="min-w-0 flex-1">
											<div className="truncate text-xs font-semibold text-white/90">
												{layer.name}
											</div>
											<div className="truncate text-[10px] text-white/40">
												{layer.compositionId}
												{item ? ` · ${item.id}` : ' · Pre-compose'}
											</div>
										</div>
										<button
											type="button"
											className={iconButtonClass}
											onClick={() =>
												setAdvanced((state) =>
													setAdvancedLayerVisibility(
														state,
														layer.id,
														!layer.visible,
													),
												)
											}
											title={layer.visible ? t('hide') : t('show')}
											aria-label={layer.visible ? t('hide') : t('show')}
										>
											{layer.visible ? (
												<Eye className="size-3.5" />
											) : (
												<EyeOff className="size-3.5" />
											)}
										</button>
										<button
											type="button"
											className={iconButtonClass}
											onClick={() =>
												setAdvanced((state) =>
													setAdvancedLayerLock(
														state,
														layer.id,
														!layer.locked,
													),
												)
											}
											title={layer.locked ? t('unlock') : t('lock')}
											aria-label={layer.locked ? t('unlock') : t('lock')}
										>
											{layer.locked ? (
												<Lock className="size-3.5" />
											) : (
												<Unlock className="size-3.5" />
											)}
										</button>
									</div>

									<div className="mt-2">
										<label className="flex items-center gap-2 text-[10px] text-white/45">
											<span className="w-12">{t('parent')}</span>
											<select
												value={layer.parentId ?? ''}
												onChange={(event) =>
													setParent(layer.id, event.target.value || null)
												}
												disabled={lockedByHierarchy}
												className="h-7 min-w-0 flex-1 rounded border border-white/10 bg-black/20 px-2 text-xs text-white outline-none focus:border-white/30"
											>
												<option value="">{t('none')}</option>
												{siblings.map((candidate) => (
													<option key={candidate.id} value={candidate.id}>
														{candidate.name}
													</option>
												))}
											</select>
										</label>
									</div>

									<div className="mt-2 grid grid-cols-2 gap-2">
										<NumericField
											label="X"
											value={layer.transform.x}
											disabled={lockedByHierarchy}
											onCommit={(value) =>
												updateTransform(layer.id, {x: value})
											}
										/>
										<NumericField
											label="Y"
											value={layer.transform.y}
											disabled={lockedByHierarchy}
											onCommit={(value) =>
												updateTransform(layer.id, {y: value})
											}
										/>
										<NumericField
											label="Scale X"
											value={layer.transform.scaleX}
											step={0.01}
											disabled={lockedByHierarchy}
											onCommit={(value) =>
												updateTransform(layer.id, {scaleX: value})
											}
										/>
										<NumericField
											label="Scale Y"
											value={layer.transform.scaleY}
											step={0.01}
											disabled={lockedByHierarchy}
											onCommit={(value) =>
												updateTransform(layer.id, {scaleY: value})
											}
										/>
										<NumericField
											label="Rotation"
											value={layer.transform.rotation}
											disabled={lockedByHierarchy}
											onCommit={(value) =>
												updateTransform(layer.id, {rotation: value})
											}
										/>
										<NumericField
											label="Opacity"
											value={layer.transform.opacity}
											step={0.01}
											disabled={lockedByHierarchy}
											onCommit={(value) =>
												updateTransform(layer.id, {
													opacity: Math.max(0, Math.min(1, value)),
												})
											}
										/>
									</div>

									<div className="mt-3 space-y-2 border-t border-white/8 pt-2">
										<div className="text-[10px] font-semibold text-white/55">
											{t('matteAndMask')}
										</div>
										<label className="flex items-center gap-2 text-[10px] text-white/45">
											<span className="w-12">{t('matte')}</span>
											<select
												value={layer.matte?.layerId ?? ''}
												onChange={(event) =>
													setMatte(
														layer.id,
														event.target.value,
														layer.matte?.type ?? 'alpha',
													)
												}
												disabled={lockedByHierarchy}
												className="h-7 min-w-0 flex-1 rounded border border-white/10 bg-black/20 px-2 text-xs text-white outline-none"
											>
												<option value="">{t('none')}</option>
												{siblings.map((candidate) => (
													<option key={candidate.id} value={candidate.id}>
														{candidate.name}
													</option>
												))}
											</select>
										</label>
										<div className="flex items-center gap-2">
											<select
												value={layer.matte?.type ?? 'alpha'}
												onChange={(event) =>
													setMatte(
														layer.id,
														layer.matte?.layerId ?? '',
														event.target.value as TrackMatteDefinition['type'],
													)
												}
												disabled={lockedByHierarchy || !layer.matte}
												className="h-7 min-w-0 flex-1 rounded border border-white/10 bg-black/20 px-2 text-xs text-white outline-none disabled:opacity-40"
											>
												<option value="alpha">{t('alpha')}</option>
												<option value="alpha-inverted">
													{t('alphaInverted')}
												</option>
												<option value="luma">{t('luma')}</option>
												<option value="luma-inverted">
													{t('lumaInverted')}
												</option>
											</select>
											<button
												type="button"
												className="h-7 rounded border border-white/10 px-2 text-[10px] text-white/70 hover:bg-white/8"
												onClick={() => toggleBasicMask(layer)}
												disabled={lockedByHierarchy}
											>
												{layer.masks?.length ? t('removeMask') : t('addMask')}
											</button>
										</div>
									</div>

									<div className="mt-3 space-y-2 border-t border-white/8 pt-2">
										<div className="flex items-center justify-between">
											<span className="text-[10px] font-semibold text-white/55">
												{t('expressions')}
											</span>
											<select
												className="h-7 rounded border border-white/10 bg-black/20 px-2 text-[10px] text-white outline-none"
												value={expressionProperty}
												onChange={(event) =>
													setExpressionProperty(
														event.target.value as ExpressionProperty,
													)
												}
												aria-label={t('expressionProperty')}
											>
												{(
													[
														'x',
														'y',
														'scaleX',
														'scaleY',
														'rotation',
														'opacity',
													] as const
												).map((property) => (
													<option key={property} value={property}>
														{property}
													</option>
												))}
											</select>
										</div>
										<textarea
											className="min-h-16 w-full resize-y rounded border border-white/10 bg-black/20 px-2 py-1.5 text-[11px] text-white outline-none focus:border-white/30"
											placeholder={t('expressionPlaceholder')}
											value={
												expressionDrafts[
													`${layer.id}:${expressionProperty}`
												] ??
												expressionFor(layer, expressionProperty)?.source ??
												''
											}
											onChange={(event) =>
												setExpressionDrafts((current) => ({
													...current,
													[`${layer.id}:${expressionProperty}`]:
														event.target.value,
												}))
											}
										/>
										<div className="flex gap-2">
											<button
												type="button"
												className="flex-1 rounded border border-white/10 px-2 py-1.5 text-[10px] text-white/75 hover:bg-white/8"
												onClick={() => applyExpression(layer)}
											>
												{t('applyExpression')}
											</button>
											<button
												type="button"
												className="rounded border border-white/10 px-2 py-1.5 text-[10px] text-white/55 hover:bg-white/8"
												onClick={() => clearExpression(layer)}
											>
												{t('clearExpression')}
											</button>
										</div>
										<div className="text-[10px] leading-4 text-white/35">
											{t('expressionHint')}
										</div>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
};
