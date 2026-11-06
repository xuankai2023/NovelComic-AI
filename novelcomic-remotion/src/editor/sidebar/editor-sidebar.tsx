import type {PlayerRef} from '@remotion/player';
import {
	FileText,
	Images,
	MoreHorizontal,
	MousePointer2,
	Plus,
	Search,
	Trash2,
} from 'lucide-react';
import {useTranslations} from 'next-intl';
import React, {useCallback, useContext, useMemo, useRef, useState} from 'react';
import {addAsset} from '../assets/add-asset';
import {EditorStarterAsset} from '../assets/assets';
import {EDITOR_ASSET_DRAG_MIME_TYPE} from '../assets/drag-data';
import {scrollbarStyle} from '../constants';
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from '../context-menu';
import {EditModeContext} from '../edit-mode';
import {FEATURE_IMPORT_ASSETS_TOOL} from '../flags';
import {AudioIcon} from '../icons/audio-icon';
import {ImageIcon} from '../icons/image';
import {UploadIcon} from '../icons/upload';
import {VideoIcon} from '../icons/video';
import {canMakeItemFromAsset} from '../items/make-item-from-asset';
import {addAssetToTimeline} from '../state/actions/add-asset-to-timeline';
import {deleteAssetFromLibrary} from '../state/actions/delete-asset-from-library';
import {clsx} from '../utils/clsx';
import {useRequireLocalUrl} from '../utils/find-asset-by-id';
import {useAssetStatus, useAssets, useWriteContext} from '../utils/use-context';

const sideButtonClassName =
	'flex w-full flex-col items-center justify-center gap-1 rounded-[10px] px-1.5 py-2 text-[11px] leading-none text-white/62 transition-colors hover:bg-white/8 hover:text-white data-[active=true]:bg-white/12 data-[active=true]:text-white';

const formatDuration = (asset: EditorStarterAsset) => {
	if (!('durationInSeconds' in asset)) {
		return null;
	}

	const totalSeconds = Math.max(0, Math.floor(asset.durationInSeconds));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const getAssetBorderColor = (asset: EditorStarterAsset) => {
	if (asset.type === 'caption') {
		return '#6FED7B';
	}

	if (asset.type === 'image' || asset.type === 'gif') {
		return '#606FF6';
	}

	if (asset.type === 'video') {
		return '#EC6FCE';
	}

	return '#F7D049';
};

const AssetFallbackIcon: React.FC<{asset: EditorStarterAsset}> = ({asset}) => {
	if (asset.type === 'audio') {
		return <AudioIcon className="h-8 w-8" />;
	}

	if (asset.type === 'caption') {
		return <FileText className="h-8 w-8" />;
	}

	if (asset.type === 'video') {
		return <VideoIcon />;
	}

	return <ImageIcon />;
};

const AssetThumbnail: React.FC<{asset: EditorStarterAsset}> = ({asset}) => {
	const localUrl = useRequireLocalUrl(asset);
	const canPreview =
		localUrl &&
		(asset.type === 'image' || asset.type === 'gif' || asset.type === 'video');

	if (canPreview && asset.type === 'video') {
		return (
			<video
				src={localUrl}
				className="h-full w-full object-cover"
				muted
				playsInline
				preload="metadata"
			/>
		);
	}

	if (canPreview) {
		return (
			<img
				src={localUrl}
				alt={asset.filename}
				className="h-full w-full object-cover"
				draggable={false}
			/>
		);
	}

	return (
		<div className="flex h-full w-full items-center justify-center bg-[#1f1f23] text-white/62">
			<AssetFallbackIcon asset={asset} />
		</div>
	);
};

const AssetCard: React.FC<{
	asset: EditorStarterAsset;
	actionPanelOpen: boolean;
	onAddToTimeline: (assetId: string) => void;
	onOpenActions: (assetId: string) => void;
	onRequestDelete: (asset: EditorStarterAsset) => void;
}> = ({
	asset,
	actionPanelOpen,
	onAddToTimeline,
	onOpenActions,
	onRequestDelete,
}) => {
	const tSidebar = useTranslations('editor.actionRow.sidebar');
	const {assetStatus} = useAssetStatus();
	const status = assetStatus[asset.id];
	const duration = formatDuration(asset);
	const canDrag = canMakeItemFromAsset(asset);
	const canAddToTimeline = canMakeItemFromAsset(asset);
	const borderColor = getAssetBorderColor(asset);

	const handleDragStart = useCallback(
		(e: React.DragEvent<HTMLDivElement>) => {
			if (!canDrag) {
				e.preventDefault();
				return;
			}

			e.dataTransfer.effectAllowed = 'copy';
			e.dataTransfer.setData(EDITOR_ASSET_DRAG_MIME_TYPE, asset.id);
		},
		[asset.id, canDrag],
	);

	const handleAddToTimeline = useCallback(() => {
		if (canAddToTimeline) {
			onAddToTimeline(asset.id);
		}
	}, [asset.id, canAddToTimeline, onAddToTimeline]);

	const handleDelete = useCallback(() => {
		onRequestDelete(asset);
	}, [asset, onRequestDelete]);

	const handleDoubleClick = useCallback(() => {
		onOpenActions(asset.id);
	}, [asset.id, onOpenActions]);

	const handleContextMenuPointerDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			e.stopPropagation();
		},
		[],
	);

	const handleActionPointerDown = useCallback(
		(e: React.PointerEvent<HTMLButtonElement>) => {
			e.stopPropagation();
		},
		[],
	);

	const handleActionDoubleClick = useCallback(
		(e: React.MouseEvent<HTMLButtonElement>) => {
			e.stopPropagation();
		},
		[],
	);

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					className={clsx(
						'min-w-0 rounded-[10px] p-1',
						actionPanelOpen && 'bg-white/6',
						canDrag && 'cursor-grab active:cursor-grabbing',
					)}
					draggable={canDrag}
					onDoubleClick={handleDoubleClick}
					onDragStart={handleDragStart}
				>
					<div
						className="bg-editor-starter-inset relative aspect-video overflow-hidden rounded-[8px] border-2 border-solid"
						style={{borderColor}}
					>
						<AssetThumbnail asset={asset} />
						<div
							className={clsx(
								'pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-black/55 opacity-0 transition-opacity',
								actionPanelOpen && 'pointer-events-auto opacity-100',
							)}
						>
							<button
								type="button"
								disabled={!canAddToTimeline}
								onClick={handleAddToTimeline}
								onPointerDown={handleActionPointerDown}
								onDoubleClick={handleActionDoubleClick}
								className="flex h-8 min-w-8 items-center justify-center gap-1.5 rounded bg-white/14 px-2 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-white/22 disabled:cursor-not-allowed disabled:opacity-40"
								title={tSidebar('addToTimeline')}
							>
								<Plus className="h-3.5 w-3.5" />
								<span>{tSidebar('addToTimelineShort')}</span>
							</button>
							<button
								type="button"
								onClick={handleDelete}
								onPointerDown={handleActionPointerDown}
								onDoubleClick={handleActionDoubleClick}
								className="flex h-8 min-w-8 items-center justify-center gap-1.5 rounded bg-red-500/22 px-2 text-[11px] font-semibold text-red-50 shadow-sm transition-colors hover:bg-red-500/34"
								title={tSidebar('deleteAsset')}
							>
								<Trash2 className="h-3.5 w-3.5" />
								<span>{tSidebar('deleteAssetShort')}</span>
							</button>
						</div>
						{duration ? (
							<div className="absolute right-1 bottom-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
								{duration}
							</div>
						) : null}
						{status?.type === 'in-progress' ? (
							<div className="absolute inset-x-0 bottom-0 h-1 bg-black/40">
								<div
									className="bg-editor-starter-accent h-full"
									style={{
										width: `${Math.round(status.progress.progress * 100)}%`,
									}}
								/>
							</div>
						) : null}
					</div>
					<div className="mt-1 truncate text-[11px] leading-4 text-white/68">
						{asset.filename}
					</div>
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem
					disabled={!canAddToTimeline}
					className="flex items-center gap-3"
					onSelect={handleAddToTimeline}
					onPointerDown={handleContextMenuPointerDown}
				>
					<Plus className="h-3.5 w-3.5" />
					{tSidebar('addToTimeline')}
				</ContextMenuItem>
				<ContextMenuItem
					className="flex items-center gap-3 text-red-200 hover:text-red-100"
					onSelect={handleDelete}
					onPointerDown={handleContextMenuPointerDown}
				>
					<Trash2 className="h-3.5 w-3.5" />
					{tSidebar('deleteAsset')}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
};

const ConfirmDeleteAssetDialog: React.FC<{
	asset: EditorStarterAsset | null;
	onCancel: () => void;
	onConfirm: (assetId: string) => void;
}> = ({asset, onCancel, onConfirm}) => {
	const tSidebar = useTranslations('editor.actionRow.sidebar');

	const handleConfirm = useCallback(() => {
		if (asset) {
			onConfirm(asset.id);
		}
	}, [asset, onConfirm]);

	if (!asset) {
		return null;
	}

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
			role="presentation"
			onMouseDown={onCancel}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="delete-asset-dialog-title"
				className="border-editor-starter-border bg-editor-starter-panel text-editor-starter-text w-full max-w-[360px] rounded-xl border p-4 shadow-2xl"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<div
					id="delete-asset-dialog-title"
					className="text-sm font-semibold text-white"
				>
					{tSidebar('confirmDeleteTitle')}
				</div>
				<div className="mt-2 text-xs leading-5 text-white/62">
					{tSidebar('confirmDeleteDescription', {filename: asset.filename})}
				</div>
				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						onClick={onCancel}
						className="h-8 rounded bg-white/8 px-3 text-xs font-medium text-white/76 transition-colors hover:bg-white/12"
					>
						{tSidebar('cancelDelete')}
					</button>
					<button
						type="button"
						onClick={handleConfirm}
						className="h-8 rounded bg-red-500/24 px-3 text-xs font-semibold text-red-50 transition-colors hover:bg-red-500/34"
					>
						{tSidebar('confirmDelete')}
					</button>
				</div>
			</div>
		</div>
	);
};

export const EditorSidebar: React.FC<{
	playerRef: React.RefObject<PlayerRef | null>;
}> = ({playerRef}) => {
	const tTools = useTranslations('editor.actionRow.tools');
	const tSidebar = useTranslations('editor.actionRow.sidebar');
	const fileInputRef = useRef<HTMLInputElement>(null);
	const timelineWriteContext = useWriteContext();
	const {assets} = useAssets();
	const {editMode, setEditMode} = useContext(EditModeContext);
	const [assetSearch, setAssetSearch] = useState('');
	const [assetPendingDelete, setAssetPendingDelete] =
		useState<EditorStarterAsset | null>(null);
	const [assetActionsOpenFor, setAssetActionsOpenFor] = useState<string | null>(
		null,
	);

	const assetList = useMemo(
		() =>
			Object.values(assets)
				.filter((asset) => !asset.hiddenFromAssetLibrary)
				.filter((asset) =>
					asset.filename
						.toLowerCase()
						.includes(assetSearch.trim().toLowerCase()),
				)
				.reverse(),
		[assetSearch, assets],
	);
	const addFile = useCallback(() => {
		fileInputRef.current?.click();
	}, []);

	const activateEditMode = useCallback(
		(mode: Parameters<typeof setEditMode>[0]) => {
			setEditMode(mode);
		},
		[setEditMode],
	);

	const handleFileChange = useCallback(
		async (e: React.ChangeEvent<HTMLInputElement>) => {
			const files = e.target.files;
			if (!files) return;

			const uploadPromises = [];
			for (const file of files) {
				uploadPromises.push(
					addAsset({
						file,
						timelineWriteContext,
						filename: file.name,
					}),
				);
			}

			await Promise.all(uploadPromises);
			e.target.value = '';
		},
		[timelineWriteContext],
	);

	const addToTimeline = useCallback(
		(assetId: string) => {
			timelineWriteContext.setState({
				update: (state) =>
					addAssetToTimeline({
						state,
						assetId,
						currentFrame: playerRef.current?.getCurrentFrame() ?? 0,
						dropPosition: null,
						resizeCompositionIfEmpty: false,
					}),
				commitToUndoStack: true,
				command: {type: 'item.create'},
			});
			setAssetActionsOpenFor(null);
		},
		[playerRef, timelineWriteContext],
	);

	const openAssetActions = useCallback((assetId: string) => {
		setAssetActionsOpenFor(assetId);
	}, []);

	const requestDeleteFromLibrary = useCallback((asset: EditorStarterAsset) => {
		setAssetPendingDelete(asset);
		setAssetActionsOpenFor(null);
	}, []);

	const cancelDeleteFromLibrary = useCallback(() => {
		setAssetPendingDelete(null);
	}, []);

	const confirmDeleteFromLibrary = useCallback(
		(assetId: string) => {
			timelineWriteContext.setState({
				update: (state) => deleteAssetFromLibrary(state, assetId),
				commitToUndoStack: true,
				command: {type: 'asset.remove'},
			});
			setAssetPendingDelete(null);
		},
		[timelineWriteContext],
	);

	return (
		<aside className="ae-sidebar flex h-full w-full overflow-hidden border-r border-black bg-[#0f0f12] text-white">
			<input
				ref={fileInputRef}
				type="file"
				accept="image/*,video/*,audio/*"
				onChange={handleFileChange}
				className="hidden"
				multiple
			/>
			<nav
				aria-label={tSidebar('toolsNavigation')}
				className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-white/5 px-1 py-3"
			>
				<button
					type="button"
					data-active={editMode === 'select'}
					className={sideButtonClassName}
					onClick={() => activateEditMode('select')}
					title={tTools('select')}
				>
					<MousePointer2 className="h-5 w-5" />
					<span>{tTools('select')}</span>
				</button>
				{FEATURE_IMPORT_ASSETS_TOOL ? (
					<button
						type="button"
						className={sideButtonClassName}
						onClick={addFile}
						title={tTools('addMedia')}
					>
						<UploadIcon />
						<span>{tSidebar('upload')}</span>
					</button>
				) : null}
				<button
					type="button"
					className={sideButtonClassName}
					data-active="true"
					title={tSidebar('assets')}
				>
					<Images className="h-5 w-5" />
					<span>{tSidebar('assets')}</span>
				</button>
			</nav>
			<section className="ae-sidebar-panel flex min-w-0 flex-1 bg-[#151518]">
				<div className="ae-panel-titlebar">
					<span>项目</span>
					<button type="button" title="面板菜单" aria-label="面板菜单">
						<MoreHorizontal size={14} />
					</button>
				</div>
				<>
					<div className="ae-panel-tabs">
						<button type="button" className="active">
							项目
						</button>
						<button type="button" disabled>
							效果
						</button>
					</div>
					<label className="ae-sidebar-search">
						<Search size={13} />
						<input
							type="search"
							value={assetSearch}
							onChange={(event) => setAssetSearch(event.target.value)}
							placeholder="搜索项目..."
							aria-label="搜索项目"
						/>
						<button
							type="button"
							title="项目面板菜单"
							aria-label="项目面板菜单"
						>
							<MoreHorizontal size={14} />
						</button>
					</label>
				</>
				<div className="ae-sidebar-panel-content flex min-w-0 flex-1 flex-col">
					<div className="ae-sidebar-upload">
						<button
							type="button"
							onClick={addFile}
							className="flex h-8 w-full items-center justify-center gap-2 rounded-[2px] bg-white/8 text-[12px] font-semibold text-white transition-colors hover:bg-white/12"
						>
							<UploadIcon />
							{tSidebar('upload')}
						</button>
					</div>
					<div
						className="ae-sidebar-assets min-h-0 flex-1 overflow-y-auto p-2.5"
						style={scrollbarStyle}
					>
						{assetList.length === 0 ? (
							<div className="flex h-full flex-col items-center justify-center rounded-[10px] border border-dashed border-white/10 px-4 text-center text-[12px] leading-5 text-white/52">
								<UploadIcon />
								<div className="mt-2 font-semibold text-white/76">
									{tSidebar('emptyTitle')}
								</div>
								<div>{tSidebar('emptyDescription')}</div>
							</div>
						) : (
							<div
								className={clsx(
									'grid grid-cols-2 gap-x-2.5 gap-y-3',
									assetList.length === 1 && 'grid-cols-1',
								)}
							>
								{assetList.map((asset) => (
									<AssetCard
										key={asset.id}
										asset={asset}
										actionPanelOpen={assetActionsOpenFor === asset.id}
										onAddToTimeline={addToTimeline}
										onOpenActions={openAssetActions}
										onRequestDelete={requestDeleteFromLibrary}
									/>
								))}
							</div>
						)}
					</div>
				</div>
			</section>
			<ConfirmDeleteAssetDialog
				asset={assetPendingDelete}
				onCancel={cancelDeleteFromLibrary}
				onConfirm={confirmDeleteFromLibrary}
			/>
		</aside>
	);
};
