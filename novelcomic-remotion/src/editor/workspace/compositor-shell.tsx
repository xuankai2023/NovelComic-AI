'use client';

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {toast} from 'sonner';
import {
	createDocumentCommand,
	createDocumentCommandId,
} from '../commands/document-command-types';
import {createEmptyDocument, createPixelLayer} from '../document/defaults';
import type {DocumentState} from '../document/types';
import {
	IndexedDBDocumentRepository,
	type DocumentProjectRecord,
} from '../project/document-repository';
import {ViewportStore, useViewportSnapshot} from '../viewport/viewport-store';
import {DocumentCanvas} from './document-canvas';
import {
	DocumentWorkspaceProvider,
	useDocumentWorkspace,
} from './document-workspace-context';
import {LayersPanel} from './layers-panel';
import {MenuBar} from './menu-bar';
import {StatusBar} from './status-bar';
import {ToolBar} from './tool-bar';
import {ToolOptionsBar} from './tool-options-bar';

const repository = new IndexedDBDocumentRepository();

const readAsDataUrl = (file: File) =>
	new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () =>
			typeof reader.result === 'string'
				? resolve(reader.result)
				: reject(new Error(`无法读取 ${file.name}`));
		reader.onerror = () =>
			reject(reader.error ?? new Error(`无法读取 ${file.name}`));
		reader.readAsDataURL(file);
	});

const imageDimensions = (url: string) =>
	new Promise<{width: number; height: number}>((resolve, reject) => {
		const image = new Image();
		image.onload = () =>
			resolve({width: image.naturalWidth, height: image.naturalHeight});
		image.onerror = () => reject(new Error('浏览器无法解码这张图片'));
		image.src = url;
	});

const contentHash = async (file: File) => {
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (globalThis.crypto?.subtle) {
		const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
		return Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, '0'),
		).join('');
	}
	let hash = 2166136261;
	for (const byte of bytes) {
		hash ^= byte;
		hash = Math.imul(hash, 16777619);
	}
	return `fallback-${file.size.toString(16)}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const addImageFiles = async (
	document: DocumentState,
	files: readonly File[],
) => {
	const next = structuredClone(document);
	const importedLayerIds: string[] = [];
	let nextOrder =
		Math.max(
			-1,
			...Object.values(next.layers)
				.filter((layer) => layer.parentId === null)
				.map((layer) => layer.order),
		) + 1;
	for (const [index, file] of files.entries()) {
		if (!file.type.startsWith('image/'))
			throw new Error(`${file.name} 不是受支持的图片文件`);
		const objectKey = await readAsDataUrl(file);
		const dimensions = await imageDimensions(objectKey);
		const hash = await contentHash(file);
		const assetId = `asset-${hash.slice(0, 24)}`;
		const layer = createPixelLayer(
			assetId,
			file.name.replace(/\.[^.]+$/, '') || file.name,
			dimensions.width,
			dimensions.height,
		);
		layer.order = nextOrder++;
		layer.transform.originX =
			Math.round((next.width - dimensions.width) / 2) + index * 16;
		layer.transform.originY =
			Math.round((next.height - dimensions.height) / 2) + index * 16;
		next.assets[assetId] ??= {
			id: assetId,
			kind: 'raster',
			originalName: file.name,
			mimeType: file.type,
			width: dimensions.width,
			height: dimensions.height,
			byteSize: file.size,
			objectKey,
			contentHash: hash,
		};
		next.layers[layer.id] = layer;
		next.rootLayerIds.push(layer.id);
		importedLayerIds.push(layer.id);
	}
	return {document: next, importedLayerIds};
};

type WorkspaceTab = Pick<DocumentState, 'projectId' | 'name'>;

const WorkspaceBody: React.FC = () => {
	const {document, dispatch, openDocument, setSelection} =
		useDocumentWorkspace();
	const viewportStoreRef = useRef<ViewportStore | null>(null);
	if (!viewportStoreRef.current) viewportStoreRef.current = new ViewportStore();
	const viewportStore = viewportStoreRef.current;
	const viewport = useViewportSnapshot(viewportStore);
	const [saving, setSaving] = useState(false);
	const [importing, setImporting] = useState(false);
	const [showNewCanvas, setShowNewCanvas] = useState(false);
	const [showProjectPicker, setShowProjectPicker] = useState(false);
	const [loadingProjects, setLoadingProjects] = useState(false);
	const [projects, setProjects] = useState<DocumentProjectRecord[]>([]);
	const [openTabs, setOpenTabs] = useState<WorkspaceTab[]>(() => [
		{projectId: document.projectId, name: document.name},
	]);
	const openDocumentsRef = useRef(
		new Map<string, DocumentState>([
			[document.projectId, structuredClone(document)],
		]),
	);
	const imageInputRef = useRef<HTMLInputElement>(null);
	const [layersPanelWidth, setLayersPanelWidth] = useState(252);
	useEffect(() => {
		const raw = window.localStorage.getItem('compositor-layers-panel-width');
		const stored = raw === null ? Number.NaN : Number(raw);
		if (Number.isFinite(stored)) {
			setLayersPanelWidth(Math.min(352, Math.max(202, stored)));
		}
	}, []);
	useEffect(() => {
		window.localStorage.setItem(
			'compositor-layers-panel-width',
			String(layersPanelWidth),
		);
	}, [layersPanelWidth]);
	useEffect(() => {
		openDocumentsRef.current.set(document.projectId, structuredClone(document));
		setOpenTabs((current) => {
			const existing = current.find(
				(tab) => tab.projectId === document.projectId,
			);
			if (!existing)
				return [
					...current,
					{projectId: document.projectId, name: document.name},
				];
			if (existing.name === document.name) return current;
			return current.map((tab) =>
				tab.projectId === document.projectId
					? {...tab, name: document.name}
					: tab,
			);
		});
	}, [document]);
	const beginLayersPanelResize = (
		event: React.PointerEvent<HTMLDivElement>,
	) => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = layersPanelWidth;
		const onMove = (moveEvent: PointerEvent) => {
			setLayersPanelWidth(
				Math.min(
					352,
					Math.max(202, Math.round(startWidth - (moveEvent.clientX - startX))),
				),
			);
		};
		const onUp = () => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp, {once: true});
	};
	const fitCanvas = useCallback(() => {
		viewportStore.fit();
	}, [viewportStore]);
	const setActualPixels = useCallback(() => {
		viewportStore.actualPixels();
	}, [viewportStore]);
	const stepZoom = useCallback(
		(direction: -1 | 1) => {
			viewportStore.zoomKeyboard(direction);
		},
		[viewportStore],
	);
	const activateDocument = useCallback(
		(nextDocument: DocumentState) => {
			openDocumentsRef.current.set(
				nextDocument.projectId,
				structuredClone(nextDocument),
			);
			setOpenTabs((current) => {
				const existing = current.some(
					(tab) => tab.projectId === nextDocument.projectId,
				);
				if (existing)
					return current.map((tab) =>
						tab.projectId === nextDocument.projectId
							? {...tab, name: nextDocument.name}
							: tab,
					);
				return [
					...current,
					{projectId: nextDocument.projectId, name: nextDocument.name},
				];
			});
			openDocument(nextDocument);
			fitCanvas();
		},
		[fitCanvas, openDocument],
	);
	const selectProject = useCallback(
		(projectId: string) => {
			if (projectId === document.projectId) return;
			openDocumentsRef.current.set(
				document.projectId,
				structuredClone(document),
			);
			const nextDocument = openDocumentsRef.current.get(projectId);
			if (!nextDocument) return;
			openDocument(nextDocument);
			fitCanvas();
		},
		[document, fitCanvas, openDocument],
	);
	const requestImageImport = useCallback(() => {
		imageInputRef.current?.click();
	}, []);
	const requestOpenProject = useCallback(async () => {
		setLoadingProjects(true);
		setShowProjectPicker(true);
		try {
			setProjects(await repository.listProjects());
		} catch (error) {
			setShowProjectPicker(false);
			toast.error(
				error instanceof Error ? error.message : '无法读取已保存项目',
			);
		} finally {
			setLoadingProjects(false);
		}
	}, []);
	const loadProject = useCallback(
		async (project: DocumentProjectRecord) => {
			setLoadingProjects(true);
			try {
				const draft = await repository.getDraft(project.projectId);
				const snapshot = draft
					? null
					: await repository.getCurrentSnapshot(project.projectId);
				const savedDocument = draft?.document ?? snapshot?.document;
				if (!savedDocument) throw new Error('项目内容不存在或已经损坏');
				activateDocument(savedDocument);
				setShowProjectPicker(false);
				toast.success(`已打开“${savedDocument.name}”`);
			} catch (error) {
				toast.error(error instanceof Error ? error.message : '打开项目失败');
			} finally {
				setLoadingProjects(false);
			}
		},
		[activateDocument],
	);
	const importImages = useCallback(
		async (files: readonly File[]) => {
			if (!files.length) return;
			setImporting(true);
			try {
				const result = await addImageFiles(document, files);
				dispatch('project.replace', {document: result.document});
				const activeId = result.importedLayerIds.at(-1);
				if (activeId) setSelection(activeId);
				toast.success(`已导入 ${result.importedLayerIds.length} 张图片`);
			} catch (error) {
				toast.error(error instanceof Error ? error.message : '图片导入失败');
			} finally {
				setImporting(false);
			}
		},
		[dispatch, document, setSelection],
	);
	const saveProject = useCallback(
		() => window.dispatchEvent(new CustomEvent('document-workspace-save')),
		[],
	);
	const exportPng = useCallback(
		() => window.dispatchEvent(new CustomEvent('document-workspace-export')),
		[],
	);
	const closeProject = useCallback(
		(projectId: string) => {
			const closingDocument = openDocumentsRef.current.get(projectId);
			if (
				closingDocument &&
				Object.keys(closingDocument.layers).length > 0 &&
				!window.confirm(`关闭“${closingDocument.name}”？`)
			)
				return;
			const closingIndex = openTabs.findIndex(
				(tab) => tab.projectId === projectId,
			);
			let remaining = openTabs.filter((tab) => tab.projectId !== projectId);
			openDocumentsRef.current.delete(projectId);
			if (projectId !== document.projectId) {
				setOpenTabs(remaining);
				return;
			}
			let nextDocument =
				openDocumentsRef.current.get(
					remaining[Math.max(0, closingIndex - 1)]?.projectId ?? '',
				) ?? null;
			if (!nextDocument) {
				nextDocument = createEmptyDocument();
				openDocumentsRef.current.set(
					nextDocument.projectId,
					structuredClone(nextDocument),
				);
				remaining = [
					{projectId: nextDocument.projectId, name: nextDocument.name},
				];
			}
			setOpenTabs(remaining);
			openDocument(nextDocument);
			fitCanvas();
		},
		[document.projectId, fitCanvas, openDocument, openTabs],
	);
	useEffect(() => {
		const save = async () => {
			setSaving(true);
			try {
				await repository.writeDraft(document.projectId, document);
				const project = await repository.getProject(document.projectId);
				if (!project) {
					await repository.createProject(document.projectId, document);
				} else {
					await repository.commit(
						createDocumentCommand({
							id: createDocumentCommandId('save'),
							requestId: createDocumentCommandId('save-request'),
							projectId: document.projectId,
							expectedRevision: project.currentRevision,
							type: 'project.replace',
							payload: {document},
						}),
						document,
						'manual',
					);
				}
				await repository.deleteDraft(document.projectId);
				toast.success('工程已保存');
			} catch (error) {
				toast.error(error instanceof Error ? error.message : '保存草稿失败');
			} finally {
				setSaving(false);
			}
		};
		const onSave = () => void save();
		window.addEventListener('document-workspace-save', onSave);
		return () => window.removeEventListener('document-workspace-save', onSave);
	}, [document]);
	useEffect(() => {
		const onExport = () => {
			const canvas = window.document.querySelector(
				'[data-testid="document-canvas"] canvas',
			) as HTMLCanvasElement | null;
			if (!canvas) return;
			const anchor = window.document.createElement('a');
			anchor.download = `${document.name || 'document'}.png`;
			anchor.href = canvas.toDataURL('image/png');
			anchor.click();
		};
		window.addEventListener('document-workspace-export', onExport);
		return () =>
			window.removeEventListener('document-workspace-export', onExport);
	}, [document.name]);
	return (
		<>
			<input
				ref={imageInputRef}
				type="file"
				accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
				multiple
				className="sr-only"
				onChange={(event) => {
					const files = Array.from(event.currentTarget.files ?? []);
					event.currentTarget.value = '';
					void importImages(files);
				}}
			/>
			<MenuBar
				zoom={viewport.transform.zoom}
				tabs={openTabs}
				activeProjectId={document.projectId}
				onFit={fitCanvas}
				onActualPixels={setActualPixels}
				onZoomIn={() => stepZoom(1)}
				onZoomOut={() => stepZoom(-1)}
				onNewCanvas={() => setShowNewCanvas(true)}
				onOpenProject={() => void requestOpenProject()}
				onImportImages={requestImageImport}
				onSave={saveProject}
				onExport={exportPng}
				onSelectProject={selectProject}
				onCloseProject={closeProject}
			/>
			<ToolOptionsBar />
			<div className="flex min-h-0 flex-1">
				<ToolBar />
				<main className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-[#0d0e11]">
					<DocumentCanvas viewportStore={viewportStore} />
				</main>
				<div
					className="relative z-10 w-px shrink-0 bg-white/8"
					onPointerDown={beginLayersPanelResize}
					role="separator"
					aria-label="调整图层面板宽度"
				>
					<span className="absolute top-0 bottom-0 left-1/2 w-2 -translate-x-1/2 cursor-col-resize" />
				</div>
				<aside
					className="flex shrink-0 flex-col"
					style={{width: layersPanelWidth}}
				>
					<LayersPanel />
				</aside>
			</div>
			<StatusBar viewportStore={viewportStore} />
			{saving ? (
				<div className="pointer-events-none absolute right-3 bottom-9 rounded bg-black/65 px-2 py-1 text-[10px] text-white/65">
					保存中…
				</div>
			) : null}
			{importing ? (
				<div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-black/25">
					<div className="rounded-lg border border-white/10 bg-[#292a2d] px-4 py-3 text-xs text-white/75 shadow-2xl">
						正在导入图片…
					</div>
				</div>
			) : null}
			{showNewCanvas ? (
				<NewCanvasDialog
					initialName="Untitled Document"
					onCancel={() => setShowNewCanvas(false)}
					onImport={() => {
						setShowNewCanvas(false);
						requestImageImport();
					}}
					onCreate={({name, width, height}) => {
						activateDocument(
							createEmptyDocument({name, width, height, resolution: 72}),
						);
						setShowNewCanvas(false);
						toast.success('新画布已创建');
					}}
				/>
			) : null}
			{showProjectPicker ? (
				<ProjectPickerDialog
					projects={projects}
					loading={loadingProjects}
					onCancel={() => setShowProjectPicker(false)}
					onOpen={(project) => void loadProject(project)}
				/>
			) : null}
		</>
	);
};

const CANVAS_PRESETS = [
	{name: '1080p', width: 1920, height: 1080},
	{name: '竖屏视频', width: 1080, height: 1920},
	{name: '方形', width: 1080, height: 1080},
	{name: '4K', width: 3840, height: 2160},
];

const NewCanvasDialog: React.FC<{
	initialName: string;
	onCancel: () => void;
	onImport: () => void;
	onCreate: (options: {name: string; width: number; height: number}) => void;
}> = ({initialName, onCancel, onImport, onCreate}) => {
	const [name, setName] = useState(
		initialName === 'Untitled Document' ? 'Untitled' : initialName,
	);
	const [width, setWidth] = useState(1920);
	const [height, setHeight] = useState(1080);
	const valid =
		name.trim().length > 0 &&
		Number.isInteger(width) &&
		Number.isInteger(height) &&
		width >= 1 &&
		height >= 1 &&
		width <= 32768 &&
		height <= 32768;
	return (
		<div
			className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-[2px]"
			role="dialog"
			aria-modal="true"
			aria-labelledby="new-canvas-title"
			onMouseDown={(event) => {
				if (event.currentTarget === event.target) onCancel();
			}}
		>
			<form
				className="w-full max-w-[500px] rounded-xl border border-white/12 bg-[#292a2d] p-7 text-white shadow-2xl"
				onSubmit={(event) => {
					event.preventDefault();
					if (valid) onCreate({name: name.trim(), width, height});
				}}
			>
				<div className="mb-6 flex items-center justify-between gap-4">
					<h2 id="new-canvas-title" className="text-lg font-semibold">
						新建画布
					</h2>
					<select
						className="h-8 rounded-full border border-white/10 bg-white/6 px-3 text-xs outline-none focus:border-blue-400/70"
						defaultValue="1080p"
						onChange={(event) => {
							const preset = CANVAS_PRESETS.find(
								(item) => item.name === event.target.value,
							);
							if (preset) {
								setWidth(preset.width);
								setHeight(preset.height);
							}
						}}
					>
						{CANVAS_PRESETS.map((preset) => (
							<option key={preset.name} value={preset.name}>
								{preset.name} · {preset.width} × {preset.height}
							</option>
						))}
					</select>
				</div>
				<label className="mb-5 block text-xs text-white/60">
					<span className="mb-2 block">项目名称</span>
					<input
						autoFocus
						value={name}
						onChange={(event) => setName(event.target.value)}
						className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-blue-400/70"
					/>
				</label>
				<div className="grid grid-cols-[1fr_auto_1fr] items-end gap-4">
					<DimensionField label="宽度" value={width} onChange={setWidth} />
					<span className="pb-2.5 text-white/30">×</span>
					<DimensionField label="高度" value={height} onChange={setHeight} />
				</div>
				<p className="mt-4 text-xs text-white/42">透明画布 · sRGB · 72 ppi</p>
				<div className="mt-7 flex items-center gap-2">
					<button type="button" className="dialog-button" onClick={onImport}>
						导入图片
					</button>
					<div className="flex-1" />
					<button type="button" className="dialog-button" onClick={onCancel}>
						取消
					</button>
					<button
						type="submit"
						disabled={!valid}
						className="dialog-button-primary"
					>
						创建画布
					</button>
				</div>
			</form>
		</div>
	);
};

const DimensionField: React.FC<{
	label: string;
	value: number;
	onChange: (value: number) => void;
}> = ({label, value, onChange}) => (
	<label className="block text-xs text-white/60">
		<span className="mb-2 block">{label}</span>
		<span className="flex h-10 items-center rounded-md border border-white/10 bg-black/20 px-3 focus-within:border-blue-400/70">
			<input
				type="number"
				min="1"
				max="32768"
				step="1"
				value={value}
				onChange={(event) => onChange(Number(event.target.value))}
				className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none"
			/>
			<span className="text-white/35">px</span>
		</span>
	</label>
);

const ProjectPickerDialog: React.FC<{
	projects: DocumentProjectRecord[];
	loading: boolean;
	onCancel: () => void;
	onOpen: (project: DocumentProjectRecord) => void;
}> = ({projects, loading, onCancel, onOpen}) => {
	const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
		projects[0]?.projectId ?? null,
	);
	const selectedProject =
		projects.find((project) => project.projectId === selectedProjectId) ?? null;
	return (
		<div
			className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-[2px]"
			role="dialog"
			aria-modal="true"
			aria-labelledby="open-project-title"
			onMouseDown={(event) => {
				if (event.currentTarget === event.target && !loading) onCancel();
			}}
		>
			<div className="flex max-h-[min(620px,80vh)] w-full max-w-[540px] flex-col rounded-xl border border-white/12 bg-[#292a2d] p-6 text-white shadow-2xl">
				<div className="mb-5">
					<h2 id="open-project-title" className="text-lg font-semibold">
						打开项目
					</h2>
					<p className="mt-1 text-xs text-white/45">保存在此浏览器中的项目</p>
				</div>
				<div className="min-h-32 flex-1 overflow-y-auto rounded-lg border border-white/8 bg-black/16 p-1.5">
					{loading && projects.length === 0 ? (
						<div className="flex h-28 items-center justify-center text-sm text-white/45">
							正在读取项目…
						</div>
					) : projects.length === 0 ? (
						<div className="flex h-28 flex-col items-center justify-center gap-1 text-sm text-white/45">
							<span>还没有已保存的项目</span>
							<span className="text-xs text-white/30">
								先用“保存项目”保存当前画布
							</span>
						</div>
					) : (
						projects.map((project) => {
							const selected = project.projectId === selectedProjectId;
							return (
								<button
									key={project.projectId}
									type="button"
									className={`flex w-full items-center gap-3 rounded-md px-3 py-3 text-left ${selected ? 'bg-[#3b82f6] text-white' : 'text-white/75 hover:bg-white/8 hover:text-white'}`}
									onClick={() => setSelectedProjectId(project.projectId)}
									onDoubleClick={() => onOpen(project)}
								>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm font-medium">
											{project.name}
										</span>
										<span
											className={`mt-0.5 block text-xs ${selected ? 'text-white/70' : 'text-white/35'}`}
										>
											{new Intl.DateTimeFormat('zh-CN', {
												dateStyle: 'medium',
												timeStyle: 'short',
											}).format(new Date(project.updatedAt))}
										</span>
									</span>
									<span
										className={`text-xs ${selected ? 'text-white/70' : 'text-white/30'}`}
									>
										r{project.currentRevision}
									</span>
								</button>
							);
						})
					)}
				</div>
				<div className="mt-5 flex justify-end gap-2">
					<button
						type="button"
						className="dialog-button"
						disabled={loading}
						onClick={onCancel}
					>
						取消
					</button>
					<button
						type="button"
						className="dialog-button-primary"
						disabled={!selectedProject || loading}
						onClick={() => selectedProject && onOpen(selectedProject)}
					>
						{loading ? '打开中…' : '打开'}
					</button>
				</div>
			</div>
		</div>
	);
};

export const CompositorShell: React.FC<{
	initialDocument?: ReturnType<typeof createEmptyDocument>;
}> = ({initialDocument}) => (
	<DocumentWorkspaceProvider initialDocument={initialDocument}>
		<div className="compositor-shell flex h-full w-full flex-col overflow-hidden rounded-[18px] border border-white/10 bg-[#242424] text-white shadow-[0_18px_50px_rgba(0,0,0,.7)]">
			<WorkspaceBody />
		</div>
	</DocumentWorkspaceProvider>
);

export const EditorRoot: React.FC = () => <CompositorShell />;
