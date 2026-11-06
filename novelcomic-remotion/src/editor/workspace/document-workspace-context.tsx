'use client';

import React, {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {documentCommandBus} from '../commands/document-command-bus';
import {DocumentCommandHistory} from '../commands/document-command-history';
import {
	createDocumentCommand,
	createDocumentCommandId,
	type DocumentCommand,
	type DocumentCommandPayloads,
	type DocumentCommandType,
} from '../commands/document-command-types';
import {createEmptyDocument} from '../document/defaults';
import type {
	DocumentState,
	LayerNode,
	SelectionRecord,
} from '../document/types';
import {
	activateBrushTip,
	isBrushStrokeActive,
	resetBrushColors,
	setBrushMode,
	swapBrushColors,
} from '../tools/brush/brush-settings';
import type {WorkspaceToolId} from '../tools/types';
export type {WorkspaceToolId} from '../tools/types';
import {toolShortcuts} from '../tools/tool-registry';

type DocumentWorkspaceContextValue = {
	document: DocumentState;
	selectedLayerIds: string[];
	activeLayerId: string | null;
	setSelection: (layerId: string, additive?: boolean) => void;
	setSelectedIds: (layerIds: string[]) => void;
	clearSelection: () => void;
	movePreview: DocumentState | null;
	setMovePreview: (document: DocumentState | null) => void;
	tool: WorkspaceToolId;
	setTool: (tool: WorkspaceToolId) => void;
	maskAlone: boolean;
	setMaskAlone: (value: boolean) => void;
	maskBrush: {size: number; hardness: number; opacity: number};
	setMaskBrush: (value: {
		size: number;
		hardness: number;
		opacity: number;
	}) => void;
	dispatch: <TType extends DocumentCommandType>(
		type: TType,
		payload: DocumentCommandPayloads[TType],
		options?: Pick<DocumentCommand, 'mergeKey' | 'transactionId'>,
	) => void;
	dispatchCommands: (commands: readonly DocumentCommand[]) => void;
	undo: () => void;
	redo: () => void;
	canUndo: boolean;
	canRedo: boolean;
	newDocument: (
		options?: Partial<
			Pick<DocumentState, 'name' | 'width' | 'height' | 'resolution'>
		>,
	) => void;
	openDocument: (document: DocumentState) => void;
	copyLayers: () => void;
	pasteLayers: () => void;
	duplicateLayers: () => void;
	groupSelectedLayers: () => void;
	clipboardLayerCount: number;
	commitSelection: (selection: SelectionRecord | null) => void;
};

const DocumentWorkspaceContext =
	createContext<DocumentWorkspaceContextValue | null>(null);

const clone = <T,>(value: T): T => structuredClone(value);

const cloneLayerSubtree = (
	document: DocumentState,
	rootId: string,
): LayerNode[] => {
	const result: LayerNode[] = [];
	const visit = (id: string) => {
		const layer = document.layers[id];
		if (!layer) return;
		result.push(clone(layer));
		Object.values(document.layers)
			.filter((candidate) => candidate.parentId === id)
			.sort((a, b) => a.order - b.order)
			.forEach((child) => visit(child.id));
	};
	visit(rootId);
	return result;
};

const makeId = (prefix: string) => createDocumentCommandId(prefix);

export const DocumentWorkspaceProvider: React.FC<{
	children: React.ReactNode;
	initialDocument?: DocumentState;
}> = ({children, initialDocument}) => {
	const [document, setDocument] = useState<DocumentState>(() =>
		clone(initialDocument ?? createEmptyDocument()),
	);
	const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>([]);
	const [movePreview, setMovePreview] = useState<DocumentState | null>(null);
	const [tool, setToolState] = useState<WorkspaceToolId>('move');
	const setTool = useCallback((next: WorkspaceToolId) => {
		activateBrushTip(next);
		setToolState(next);
	}, []);
	const [maskAlone, setMaskAlone] = useState(false);
	const [maskBrush, setMaskBrush] = useState({
		size: 48,
		hardness: 0.75,
		opacity: 1,
	});
	const historyRef = useRef(new DocumentCommandHistory());
	const clipboardRef = useRef<LayerNode[]>([]);
	const [, setHistoryRevision] = useState(0);
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target as HTMLElement | null;
			if (target?.matches('input, textarea, select, [contenteditable="true"]'))
				return;
			const key = event.key.toLowerCase();
			// B paints and E erases on the same brush, the way Compositor does. A stroke
			// already on the canvas keeps the tool it started with.
			if (key === 'b' || key === 'e') {
				if (!isBrushStrokeActive()) {
					event.preventDefault();
					setBrushMode(key === 'e' ? 'erase' : 'paint');
					activateBrushTip('brush');
					setTool('brush');
				}
				return;
			}
			if (key === 'x') {
				event.preventDefault();
				swapBrushColors();
				return;
			}
			if (key === 'd' && !event.shiftKey) {
				event.preventDefault();
				resetBrushColors();
				return;
			}
			const nextTool = toolShortcuts[key];
			if (nextTool) {
				event.preventDefault();
				activateBrushTip(nextTool);
				setTool(nextTool);
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, []);

	const dispatch = useCallback(
		<TType extends DocumentCommandType>(
			type: TType,
			payload: DocumentCommandPayloads[TType],
			options: Pick<DocumentCommand, 'mergeKey' | 'transactionId'> = {},
		) => {
			setDocument((current) => {
				const command = createDocumentCommand({
					type,
					payload,
					projectId: current.projectId,
					expectedRevision: 0,
					...options,
				});
				const next = historyRef.current.execute(current, command);
				return clone(next);
			});
			setHistoryRevision((value) => value + 1);
		},
		[],
	);

	const dispatchCommands = useCallback(
		(commands: readonly DocumentCommand[]) => {
			setDocument((current) =>
				clone(historyRef.current.executeTransaction(current, commands)),
			);
			setHistoryRevision((value) => value + 1);
		},
		[],
	);

	const undo = useCallback(() => {
		setDocument((current) => clone(historyRef.current.undo(current)));
		setHistoryRevision((value) => value + 1);
	}, []);
	const redo = useCallback(() => {
		setDocument((current) => clone(historyRef.current.redo(current)));
		setHistoryRevision((value) => value + 1);
	}, []);

	const setSelection = useCallback((layerId: string, additive = false) => {
		setSelectedLayerIds((current) => {
			if (!additive) return [layerId];
			return current.includes(layerId)
				? current.filter((id) => id !== layerId)
				: [...current, layerId];
		});
	}, []);
	const setSelectedIds = useCallback((layerIds: string[]) => {
		setSelectedLayerIds(layerIds.filter((id, index) => layerIds.indexOf(id) === index));
	}, []);
	const clearSelection = useCallback(() => setSelectedLayerIds([]), []);
	const commitSelection = useCallback(
		(selection: SelectionRecord | null) => {
			dispatch('selection.commit', {selection});
		},
		[dispatch],
	);
	const newDocument = useCallback(
		(
			options: Partial<
				Pick<DocumentState, 'name' | 'width' | 'height' | 'resolution'>
			> = {},
		) => {
			const next = createEmptyDocument(options);
			historyRef.current.clear();
			setDocument(next);
			setSelectedLayerIds([]);
			setHistoryRevision((value) => value + 1);
		},
		[],
	);
	const openDocument = useCallback((nextDocument: DocumentState) => {
		historyRef.current.clear();
		setDocument(clone(nextDocument));
		setSelectedLayerIds([]);
		setHistoryRevision((value) => value + 1);
	}, []);

	const copyLayers = useCallback(() => {
		const selected = new Set(selectedLayerIds);
		const roots = selectedLayerIds.filter((id) => {
			let parent = document.layers[id]?.parentId ?? null;
			while (parent) {
				if (selected.has(parent)) return false;
				parent = document.layers[parent]?.parentId ?? null;
			}
			return true;
		});
		clipboardRef.current = roots
			.flatMap((id) => cloneLayerSubtree(document, id))
			.map((layer) =>
				selected.has(layer.id) ? {...layer, parentId: null} : layer,
			);
		setHistoryRevision((value) => value + 1);
	}, [document, selectedLayerIds]);

	const duplicateLayers = useCallback(() => {
		const selected = new Set(selectedLayerIds);
		const roots = selectedLayerIds
			.filter((id) => {
				let parent = document.layers[id]?.parentId ?? null;
				while (parent) {
					if (selected.has(parent)) return false;
					parent = document.layers[parent]?.parentId ?? null;
				}
				return true;
			})
			.map((id) => document.layers[id])
			.filter((layer): layer is LayerNode => Boolean(layer));
		if (!roots.length) return;
		const commands: DocumentCommand[] = [];
		const newSelection: string[] = [];
		for (const root of roots) {
			const source = cloneLayerSubtree(document, root.id);
			const idMap = new Map(source.map((layer) => [layer.id, makeId('layer')]));
			for (const sourceLayer of source) {
				const layer = {
					...sourceLayer,
					id: idMap.get(sourceLayer.id)!,
					name: `${sourceLayer.name} copy`,
					parentId: sourceLayer.parentId
						? (idMap.get(sourceLayer.parentId) ?? root.parentId)
						: root.parentId,
					order: root.order + 1,
				};
				commands.push(
					createDocumentCommand({
						type: 'layer.create',
						projectId: document.projectId,
						payload: {layer},
					}),
				);
				if (sourceLayer.id === root.id) newSelection.push(layer.id);
			}
		}
		if (commands.length) {
			dispatchCommands(commands);
			setSelectedLayerIds(newSelection);
		}
	}, [dispatchCommands, document, selectedLayerIds]);
	const groupSelectedLayers = useCallback(() => {
		const layers = selectedLayerIds
			.map((id) => document.layers[id])
			.filter((layer): layer is LayerNode => Boolean(layer));
		if (layers.length < 1) return;
		const groupLayer: LayerNode = {
			id: makeId('layer'),
			name: '新建组',
			kind: 'group',
			parentId: null,
			order: Math.min(...layers.map((layer) => layer.order)),
			visible: true,
			locked: false,
			solo: false,
			opacity: 1,
			blendMode: 'normal',
			transform: {
				originX: 0,
				originY: 0,
				width: document.width,
				height: document.height,
				rotation: 0,
				scaleX: 1,
				scaleY: 1,
				sampling: 'smooth',
			},
			content: {kind: 'group', group: true},
		};
		const transactionId = makeId('transaction');
		const commands: DocumentCommand[] = [
			createDocumentCommand({
				type: 'layer.create',
				projectId: document.projectId,
				payload: {layer: groupLayer},
				transactionId,
			}),
		];
		for (const layer of layers)
			commands.push(
				createDocumentCommand({
					type: 'layer.reorder',
					projectId: document.projectId,
					payload: {
						layerId: layer.id,
						parentId: groupLayer.id,
						order: layer.order,
					},
					transactionId,
				}),
			);
		dispatchCommands(commands);
		setSelectedLayerIds([groupLayer.id]);
	}, [dispatchCommands, document, selectedLayerIds]);

	const pasteLayers = useCallback(() => {
		if (!clipboardRef.current.length) return;
		const roots = clipboardRef.current.filter(
			(layer) => layer.parentId === null,
		);
		const idMap = new Map(
			clipboardRef.current.map((layer) => [layer.id, makeId('layer')]),
		);
		const commands = clipboardRef.current.map((source) =>
			createDocumentCommand({
				type: 'layer.create',
				projectId: document.projectId,
				payload: {
					layer: {
						...clone(source),
						id: idMap.get(source.id)!,
						parentId: source.parentId
							? (idMap.get(source.parentId) ?? null)
							: null,
						name: `${source.name} copy`,
					},
				},
			}),
		);
		if (commands.length) {
			dispatchCommands(commands);
			setSelectedLayerIds(
				roots.map((root) => idMap.get(root.id)!).filter(Boolean),
			);
		}
	}, [dispatchCommands, document]);

	const value = useMemo<DocumentWorkspaceContextValue>(
		() => ({
			document,
			selectedLayerIds,
			activeLayerId: selectedLayerIds.at(-1) ?? null,
			setSelection,
			setSelectedIds,
			clearSelection,
			movePreview,
			setMovePreview,
			tool,
			setTool,
			maskAlone,
			setMaskAlone,
			maskBrush,
			setMaskBrush,
			dispatch,
			dispatchCommands,
			undo,
			redo,
			canUndo: historyRef.current.canUndo,
			canRedo: historyRef.current.canRedo,
			newDocument,
			openDocument,
			copyLayers,
			pasteLayers,
			duplicateLayers,
			groupSelectedLayers,
			clipboardLayerCount: clipboardRef.current.length,
			commitSelection,
		}),
		[
			clearSelection,
			commitSelection,
			movePreview,
			copyLayers,
			dispatch,
			dispatchCommands,
			document,
			duplicateLayers,
			groupSelectedLayers,
			maskAlone,
			maskBrush,
			newDocument,
			openDocument,
			pasteLayers,
			redo,
			selectedLayerIds,
			setSelectedIds,
			setSelection,
			tool,
			undo,
		],
	);

	return (
		<DocumentWorkspaceContext.Provider value={value}>
			{children}
		</DocumentWorkspaceContext.Provider>
	);
};

export const useDocumentWorkspace = () => {
	const value = useContext(DocumentWorkspaceContext);
	if (!value) throw new Error('DocumentWorkspaceProvider is missing');
	return value;
};

export const useOptionalDocumentWorkspace = () =>
	useContext(DocumentWorkspaceContext);

export const applyWorkspaceCommand = <TType extends DocumentCommandType>(
	document: DocumentState,
	type: TType,
	payload: DocumentCommandPayloads[TType],
) =>
	documentCommandBus.execute(
		document,
		createDocumentCommand({type, payload, projectId: document.projectId}),
	).document;
