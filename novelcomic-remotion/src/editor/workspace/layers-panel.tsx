'use client';

import {
	ChevronDown,
	ChevronRight,
	Circle,
	Eye,
	EyeOff,
	FilePlus2,
	FolderPlus,
	GripVertical,
	Layers3,
	Lock,
	Sparkles,
	Trash2,
	Unlock,
} from 'lucide-react';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
	createAdjustmentLayer,
	createGroupLayer,
	createPixelLayer,
} from '../document/defaults';
import {BLEND_MODES, type BlendMode, type LayerNode} from '../document/types';
import {useDocumentWorkspace} from './document-workspace-context';
import {
	buildLayerTreeRows,
	canDropLayer,
	layerKindLabel,
} from './layer-tree-model';

const panelButton =
	'flex size-8 items-center justify-center rounded-md text-white/55 transition-colors hover:bg-white/8 hover:text-white disabled:cursor-not-allowed disabled:opacity-25';

const layerIcon = (layer: LayerNode) => {
	if (layer.kind === 'group') return <FolderPlus className="size-4" />;
	if (layer.kind === 'adjustment')
		return <Circle className="size-4 fill-white/25" />;
	return <FilePlus2 className="size-4" />;
};

const layerName = (layer: LayerNode) =>
	layer.name.trim() || layerKindLabel(layer) + '图层';

const blendModeLabel: Record<BlendMode, string> = {
	normal: 'Normal',
	multiply: 'Multiply',
	screen: 'Screen',
	overlay: 'Overlay',
	darken: 'Darken',
	lighten: 'Lighten',
	'color-dodge': 'Color Dodge',
	'color-burn': 'Color Burn',
	'hard-light': 'Hard Light',
	'soft-light': 'Soft Light',
	difference: 'Difference',
	exclusion: 'Exclusion',
	hue: 'Hue',
	saturation: 'Saturation',
	color: 'Color',
	luminosity: 'Luminosity',
};

export const LayersPanel: React.FC = () => {
	const {
		document,
		selectedLayerIds,
		activeLayerId,
		setSelection,
		clearSelection,
		dispatch,
		groupSelectedLayers,
	} = useDocumentWorkspace();
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingName, setEditingName] = useState('');
	const rows = useMemo(
		() => buildLayerTreeRows(document, expanded),
		[document, expanded],
	);
	const activeLayer = activeLayerId ? document.layers[activeLayerId] : null;

	const createLayer = useCallback(
		(layer: LayerNode) => {
			layer.order =
				Math.max(
					-1,
					...Object.values(document.layers)
						.filter((candidate) => candidate.parentId === layer.parentId)
						.map((candidate) => candidate.order),
				) + 1;
			dispatch('layer.create', {layer});
			setSelection(layer.id);
		},
		[dispatch, document.layers, setSelection],
	);
	const createGroup = useCallback(() => {
		if (selectedLayerIds.length > 0) {
			groupSelectedLayers();
			return;
		}
		const group = createGroupLayer('New Group');
		group.order = document.rootLayerIds.length;
		createLayer(group);
	}, [
		createLayer,
		document.rootLayerIds.length,
		groupSelectedLayers,
		selectedLayerIds.length,
	]);
	const createAdjustment = useCallback(
		() =>
			createLayer(createAdjustmentLayer({kind: 'invert'}, 'New Adjustment')),
		[createLayer],
	);
	const createPixel = useCallback(() => {
		const assetId = 'asset-' + Date.now().toString(36);
		const layer = createPixelLayer(
			assetId,
			'New Layer',
			Math.min(640, document.width),
			Math.min(360, document.height),
		);
		const next = structuredClone(document);
		layer.order =
			Math.max(
				-1,
				...Object.values(next.layers)
					.filter((candidate) => candidate.parentId === null)
					.map((candidate) => candidate.order),
			) + 1;
		next.assets[assetId] = {
			id: assetId,
			kind: 'raster',
			originalName: 'blank-layer.png',
			mimeType: 'image/png',
			byteSize: 0,
			objectKey: '',
			contentHash: '',
		};
		next.layers[layer.id] = layer;
		next.rootLayerIds = [...next.rootLayerIds, layer.id];
		dispatch('project.replace', {document: next});
		setSelection(layer.id);
	}, [dispatch, document, setSelection]);

	const beginRename = (layer: LayerNode) => {
		setEditingId(layer.id);
		setEditingName(layerName(layer));
	};
	const commitRename = () => {
		if (!editingId) return;
		const name = editingName.trim();
		if (name)
			dispatch(
				'layer.update',
				{layerId: editingId, changes: {name}},
				{mergeKey: 'layer.rename:' + editingId},
			);
		setEditingId(null);
	};
	const deleteSelected = useCallback(() => {
		for (const layerId of [...selectedLayerIds].reverse())
			dispatch('layer.delete', {layerId});
		clearSelection();
	}, [clearSelection, dispatch, selectedLayerIds]);
	useEffect(() => {
		const createGroupHandler = () => createGroup();
		const deleteHandler = () => deleteSelected();
		const clearHandler = () => clearSelection();
		const groupHandler = () => groupSelectedLayers();
		window.addEventListener(
			'document-workspace-create-group',
			createGroupHandler,
		);
		window.addEventListener('document-workspace-delete', deleteHandler);
		window.addEventListener('document-workspace-clear-selection', clearHandler);
		window.addEventListener('document-workspace-group', groupHandler);
		return () => {
			window.removeEventListener(
				'document-workspace-create-group',
				createGroupHandler,
			);
			window.removeEventListener('document-workspace-delete', deleteHandler);
			window.removeEventListener(
				'document-workspace-clear-selection',
				clearHandler,
			);
			window.removeEventListener('document-workspace-group', groupHandler);
		};
	}, [clearSelection, createGroup, deleteSelected, groupSelectedLayers]);
	const onDrop = (event: React.DragEvent, target: LayerNode) => {
		event.preventDefault();
		const layerId = event.dataTransfer.getData('application/x-document-layer');
		if (!layerId || layerId === target.id) return;
		const source = document.layers[layerId];
		if (!source) return;
		const parentId = target.kind === 'group' ? target.id : target.parentId;
		if (!canDropLayer(document, layerId, parentId)) return;
		const order =
			target.kind === 'group'
				? Object.values(document.layers).filter(
						(layer) => layer.parentId === target.id,
					).length
				: target.order;
		dispatch('layer.reorder', {layerId, parentId, order});
		if (target.kind === 'group')
			setExpanded((current) => new Set(current).add(target.id));
	};
	const updateActiveLayer = (
		changes: Partial<Pick<LayerNode, 'opacity' | 'blendMode'>>,
	) => {
		if (!activeLayer) return;
		dispatch(
			'layer.update',
			{layerId: activeLayer.id, changes},
			{mergeKey: 'layer.appearance:' + activeLayer.id},
		);
	};

	return (
		<section
			className="flex min-h-0 flex-1 flex-col bg-[#242424] text-white"
			aria-label="图层面板"
			data-testid="layers-panel"
		>
			<div className="flex shrink-0 items-center justify-between px-[18px] py-[18px]">
				<span className="text-xs font-semibold">Layers</span>
				<span className="font-mono text-[11px] text-white/30 tabular-nums">
					{Object.keys(document.layers).length}
				</span>
			</div>
			<div className="h-px shrink-0 bg-white/8" />
			<div
				className="shrink-0 space-y-2 p-3 text-[11px] text-white/65"
				data-testid="layer-appearance-controls"
			>
				<label className="flex items-center gap-3">
					<span className="w-12 shrink-0">Blend</span>
					<select
						className="h-7 min-w-0 flex-1 rounded-md border border-white/10 bg-[#303030] px-2 text-[11px] text-white/80 outline-none disabled:opacity-35"
						disabled={!activeLayer}
						value={activeLayer?.blendMode ?? 'normal'}
						onChange={(event) =>
							updateActiveLayer({blendMode: event.target.value as BlendMode})
						}
					>
						{BLEND_MODES.map((mode) => (
							<option key={mode} value={mode}>
								{blendModeLabel[mode]}
							</option>
						))}
					</select>
				</label>
				<label className="flex items-center gap-2">
					<span className="w-12 shrink-0">Opacity</span>
					<input
						className="min-w-0 flex-1"
						type="range"
						min="0"
						max="100"
						step="1"
						disabled={!activeLayer}
						value={Math.round((activeLayer?.opacity ?? 1) * 100)}
						onChange={(event) =>
							updateActiveLayer({opacity: Number(event.target.value) / 100})
						}
					/>
					<span className="flex h-7 w-[54px] items-center justify-end rounded-md border border-white/10 bg-[#303030] px-2 font-mono text-white/75 tabular-nums">
						{Math.round((activeLayer?.opacity ?? 1) * 100)}%
					</span>
				</label>
			</div>
			<div className="h-px shrink-0 bg-white/8" />
			<div className="min-h-0 flex-1 overflow-y-auto py-1">
				{rows.map(({layer, depth}) => {
					const selected = selectedLayerIds.includes(layer.id);
					const isExpanded = expanded.has(layer.id);
					return (
						<div
							key={layer.id}
							draggable
							onDragStart={(event) =>
								event.dataTransfer.setData(
									'application/x-document-layer',
									layer.id,
								)
							}
							onDragOver={(event) => event.preventDefault()}
							onDrop={(event) => onDrop(event, layer)}
							className={
								'group flex min-h-[52px] items-center gap-1 border-b border-white/5 pr-2 text-xs ' +
								(selected
									? 'bg-[#0a64c8] text-white'
									: 'text-white/72 hover:bg-white/6')
							}
							style={{paddingLeft: String(8 + depth * 16) + 'px'}}
							onClick={(event) =>
								setSelection(
									layer.id,
									event.metaKey || event.ctrlKey || event.shiftKey,
								)
							}
						>
							{layer.kind === 'group' ? (
								<button
									className={panelButton}
									type="button"
									onClick={(event) => {
										event.stopPropagation();
										setExpanded((current) => {
											const next = new Set(current);
											if (next.has(layer.id)) next.delete(layer.id);
											else next.add(layer.id);
											return next;
										});
									}}
									title={isExpanded ? '折叠组' : '展开组'}
									aria-label={isExpanded ? '折叠组' : '展开组'}
								>
									{isExpanded ? (
										<ChevronDown className="size-3.5" />
									) : (
										<ChevronRight className="size-3.5" />
									)}
								</button>
							) : (
								<span className="size-8" />
							)}
							<button
								className={panelButton + ' shrink-0'}
								type="button"
								onClick={(event) => {
									event.stopPropagation();
									dispatch('layer.update', {
										layerId: layer.id,
										changes: {visible: !layer.visible},
									});
								}}
								title={layer.visible ? '隐藏图层' : '显示图层'}
								aria-label={layer.visible ? '隐藏图层' : '显示图层'}
							>
								{layer.visible ? (
									<Eye className="size-3.5" />
								) : (
									<EyeOff className="size-3.5" />
								)}
							</button>
							<span className="flex size-9 shrink-0 items-center justify-center rounded-[3px] bg-white/4 text-white/50">
								{layerIcon(layer)}
							</span>
							{editingId === layer.id ? (
								<input
									autoFocus
									value={editingName}
									onChange={(event) => setEditingName(event.target.value)}
									onBlur={commitRename}
									onKeyDown={(event) => {
										if (event.key === 'Enter') commitRename();
										if (event.key === 'Escape') setEditingId(null);
									}}
									onClick={(event) => event.stopPropagation()}
									className="min-w-0 flex-1 rounded border border-blue-400/60 bg-black/30 px-1 text-xs outline-none"
								/>
							) : (
								<button
									type="button"
									className="min-w-0 flex-1 truncate text-left"
									onDoubleClick={(event) => {
										event.stopPropagation();
										beginRename(layer);
									}}
									title={layerName(layer)}
								>
									{layerName(layer)}
								</button>
							)}
							{layer.locked ? (
								<Lock className="size-3.5 shrink-0 text-white/55" />
							) : null}
							<button
								className={panelButton + ' opacity-0 group-hover:opacity-100'}
								type="button"
								onClick={(event) => {
									event.stopPropagation();
									dispatch('layer.update', {
										layerId: layer.id,
										changes: {locked: !layer.locked},
									});
								}}
								title={layer.locked ? '解锁图层' : '锁定图层'}
								aria-label={layer.locked ? '解锁图层' : '锁定图层'}
							>
								{layer.locked ? (
									<Unlock className="size-3.5" />
								) : (
									<Lock className="size-3.5" />
								)}
							</button>
							<GripVertical className="size-3.5 shrink-0 text-white/18" />
						</div>
					);
				})}
				{!rows.length ? (
					<div className="flex h-full min-h-52 flex-col items-center justify-center gap-2.5 px-4 text-center text-white/42">
						<Layers3 className="size-7 stroke-[1.3]" />
						<span className="text-[13px] font-medium text-white/58">
							No layers yet
						</span>
						<span className="max-w-44 text-[11px] leading-4">
							Import an image or add a blank layer.
						</span>
					</div>
				) : null}
			</div>
			<div className="h-px shrink-0 bg-white/8" />
			<div className="flex h-14 shrink-0 items-center px-2 py-1">
				<button
					className={panelButton}
					type="button"
					onClick={createPixel}
					title="New blank layer"
					aria-label="New blank layer"
				>
					<FilePlus2 className="size-4" />
				</button>
				<button
					className={panelButton}
					type="button"
					onClick={createGroup}
					title="New folder"
					aria-label="New folder"
				>
					<FolderPlus className="size-4" />
				</button>
				<button
					className={panelButton}
					type="button"
					disabled
					title="Layer mask"
					aria-label="Layer mask"
				>
					<Layers3 className="size-4" />
				</button>
				<button
					className={panelButton}
					type="button"
					disabled
					title="Layer effects"
					aria-label="Layer effects"
				>
					<Sparkles className="size-4" />
				</button>
				<button
					className={panelButton}
					type="button"
					onClick={createAdjustment}
					title="New adjustment layer"
					aria-label="New adjustment layer"
				>
					<Circle className="size-4 fill-white/25" />
				</button>
				<div className="flex-1" />
				<button
					className={panelButton}
					type="button"
					onClick={deleteSelected}
					disabled={!selectedLayerIds.length}
					title="Delete layer"
					aria-label="Delete layer"
				>
					<Trash2 className="size-4" />
				</button>
			</div>
		</section>
	);
};
