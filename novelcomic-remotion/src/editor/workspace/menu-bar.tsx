'use client';

import {
	Download,
	FilePlus2,
	FolderOpen,
	ImagePlus,
	Plus,
	Save,
	X,
	ZoomIn,
	ZoomOut,
} from 'lucide-react';
import React, {useEffect, useRef, useState} from 'react';
import {useDocumentWorkspace} from './document-workspace-context';

export const MenuBar: React.FC<{
	zoom: number;
	tabs: Array<{projectId: string; name: string}>;
	activeProjectId: string;
	onFit: () => void;
	onActualPixels: () => void;
	onZoomIn: () => void;
	onZoomOut: () => void;
	onNewCanvas: () => void;
	onOpenProject: () => void;
	onImportImages: () => void;
	onSave: () => void;
	onExport: () => void;
	onSelectProject: (projectId: string) => void;
	onCloseProject: (projectId: string) => void;
}> = ({
	zoom,
	tabs,
	activeProjectId,
	onFit,
	onActualPixels,
	onZoomIn,
	onZoomOut,
	onNewCanvas,
	onOpenProject,
	onImportImages,
	onSave,
	onExport,
	onSelectProject,
	onCloseProject,
}) => {
	const {
		document: workspaceDocument,
		selectedLayerIds,
		undo,
		redo,
		duplicateLayers,
		dispatch,
	} = useDocumentWorkspace();
	const menuRef = useRef<HTMLDivElement>(null);
	const [projectMenuOpen, setProjectMenuOpen] = useState(false);
	useEffect(() => {
		const close = (event: MouseEvent) => {
			if (!menuRef.current?.contains(event.target as Node))
				setProjectMenuOpen(false);
		};
		window.document.addEventListener('mousedown', close);
		return () => window.document.removeEventListener('mousedown', close);
	}, []);
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const modifier = event.metaKey || event.ctrlKey;
			if (modifier && event.key.toLowerCase() === 'z') {
				event.preventDefault();
				(event.shiftKey ? redo : undo)();
			} else if (modifier && event.key.toLowerCase() === 'n') {
				event.preventDefault();
				onNewCanvas();
			} else if (modifier && event.key.toLowerCase() === 'o') {
				event.preventDefault();
				onOpenProject();
			} else if (
				modifier &&
				event.shiftKey &&
				event.key.toLowerCase() === 'i'
			) {
				event.preventDefault();
				onImportImages();
			} else if (modifier && event.key.toLowerCase() === 's') {
				event.preventDefault();
				onSave();
			} else if (
				modifier &&
				event.shiftKey &&
				event.key.toLowerCase() === 'e'
			) {
				event.preventDefault();
				onExport();
			} else if (modifier && event.key.toLowerCase() === 'j') {
				event.preventDefault();
				duplicateLayers();
			} else if (
				modifier &&
				event.key.toLowerCase() === 'g' &&
				selectedLayerIds.length
			) {
				event.preventDefault();
				dispatch('layer.update', {
					layerId: selectedLayerIds[0],
					changes: {name: workspaceDocument.layers[selectedLayerIds[0]]?.name},
				});
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [
		dispatch,
		duplicateLayers,
		onExport,
		onImportImages,
		onNewCanvas,
		onOpenProject,
		onSave,
		redo,
		selectedLayerIds,
		undo,
		workspaceDocument.layers,
	]);

	return (
		<header
			ref={menuRef}
			className="flex h-12 shrink-0 items-center border-b border-white/8 bg-[#22292d] px-3 text-white"
			aria-label="Document toolbar"
			data-testid="menu-bar"
		>
			<div className="relative mr-3">
				<button
					type="button"
					className="flex size-8 items-center justify-center rounded-full border border-white/10 bg-white/4 text-white/70 hover:bg-white/10 hover:text-white"
					onClick={() => setProjectMenuOpen((open) => !open)}
					title="项目操作"
					aria-label="项目操作"
					aria-expanded={projectMenuOpen}
				>
					<Plus className="size-4" />
				</button>
				{projectMenuOpen ? (
					<div className="absolute top-10 left-0 z-50 w-52 overflow-hidden rounded-lg border border-white/12 bg-[#2b2c2f] p-1.5 text-xs shadow-2xl">
						<ProjectMenuItem
							icon={FilePlus2}
							label="新建画布"
							shortcut="⌘N"
							onClick={() => {
								setProjectMenuOpen(false);
								onNewCanvas();
							}}
						/>
						<ProjectMenuItem
							icon={FolderOpen}
							label="打开项目"
							shortcut="⌘O"
							onClick={() => {
								setProjectMenuOpen(false);
								onOpenProject();
							}}
						/>
						<ProjectMenuItem
							icon={ImagePlus}
							label="导入图片"
							shortcut="⇧⌘I"
							onClick={() => {
								setProjectMenuOpen(false);
								onImportImages();
							}}
						/>
						<div className="my-1 h-px bg-white/8" />
						<ProjectMenuItem
							icon={Save}
							label="保存项目"
							shortcut="⌘S"
							onClick={() => {
								setProjectMenuOpen(false);
								onSave();
							}}
						/>
						<ProjectMenuItem
							icon={Download}
							label="导出 PNG"
							shortcut="⇧⌘E"
							onClick={() => {
								setProjectMenuOpen(false);
								onExport();
							}}
						/>
					</div>
				) : null}
			</div>
			<div className="flex max-w-[min(46vw,680px)] min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				{tabs.map((tab) => {
					const active = tab.projectId === activeProjectId;
					return (
						<div
							key={tab.projectId}
							className={`group flex h-8 max-w-56 min-w-28 shrink-0 items-center rounded-full border ${active ? 'border-white/14 bg-white/10 text-white/85' : 'border-transparent text-white/45 hover:bg-white/6 hover:text-white/75'}`}
						>
							<button
								type="button"
								className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 pl-3 text-[13px] font-semibold"
								title={tab.name}
								onClick={() => onSelectProject(tab.projectId)}
								aria-current={active ? 'page' : undefined}
							>
								<span
									className={`size-1.5 shrink-0 rounded-full ${active ? 'bg-white/75' : 'bg-white/25'}`}
								/>
								<span className="min-w-0 flex-1 truncate">
									{tab.name.replace(/ Document$/, '') || 'Untitled'}
								</span>
							</button>
							<button
								type="button"
								className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-full text-white/35 hover:bg-white/10 hover:text-white/80"
								onClick={() => onCloseProject(tab.projectId)}
								title={`关闭 ${tab.name}`}
								aria-label={`关闭 ${tab.name}`}
							>
								<X className="size-3.5" />
							</button>
						</div>
					);
				})}
			</div>
			<div className="flex-1" />
			<button
				type="button"
				className="toolbar-pill"
				onClick={onFit}
				title="Fit canvas in window (⌘0)"
			>
				Fit
			</button>
			<button
				type="button"
				className="toolbar-pill ml-2"
				onClick={onActualPixels}
				title="Actual pixels (⌘1)"
			>
				100%
			</button>
			<div className="ml-2 flex h-8 items-center rounded-full border border-white/10 bg-white/3 px-1">
				<button
					type="button"
					className="toolbar-icon"
					onClick={onZoomIn}
					title="Zoom in"
					aria-label="Zoom in"
				>
					<ZoomIn className="size-4" />
				</button>
				<button
					type="button"
					className="toolbar-icon"
					onClick={onZoomOut}
					title="Zoom out"
					aria-label="Zoom out"
				>
					<ZoomOut className="size-4" />
				</button>
			</div>
			<span className="sr-only">Current zoom {Math.round(zoom * 100)}%</span>
		</header>
	);
};

const ProjectMenuItem: React.FC<{
	icon: React.ComponentType<{className?: string}>;
	label: string;
	shortcut: string;
	onClick: () => void;
}> = ({icon: Icon, label, shortcut, onClick}) => (
	<button
		type="button"
		className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-white/78 hover:bg-white/10 hover:text-white"
		onClick={onClick}
	>
		<Icon className="size-4 text-white/55" />
		<span>{label}</span>
		<kbd className="ml-auto text-[10px] text-white/35">{shortcut}</kbd>
	</button>
);
