import {PlayerRef} from '@remotion/player';
import React, {useCallback, useMemo} from 'react';
import {AbsoluteFill} from 'remotion';
import {addAsset} from './assets/add-asset';
import {EDITOR_ASSET_DRAG_MIME_TYPE} from './assets/drag-data';
import {DropPosition} from './assets/drop-position';
import {CANVAS_PADDING} from './canvas/canvas';
import {
	FEATURE_DROP_ASSETS_ON_CANVAS,
	FEATURE_DROP_ASSETS_ON_TIMELINE,
} from './flags';
import {addAssetToTimeline} from './state/actions/add-asset-to-timeline';
import {useWriteContext} from './utils/use-context';

export const DropHandler: React.FC<{
	children: React.ReactNode;
	playerRef: React.RefObject<PlayerRef | null>;
	context: 'canvas' | 'timeline';
}> = ({children, playerRef, context}) => {
	const timelineWriteContext = useWriteContext();

	const onDragOver: React.DragEventHandler = useCallback(
		(e) => {
			if (!FEATURE_DROP_ASSETS_ON_TIMELINE && context === 'timeline') {
				return;
			}

			if (!FEATURE_DROP_ASSETS_ON_CANVAS && context === 'canvas') {
				return;
			}

			if (
				e.dataTransfer.files.length === 0 &&
				!e.dataTransfer.types.includes(EDITOR_ASSET_DRAG_MIME_TYPE)
			) {
				return;
			}

			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = 'copy';
		},
		[context],
	);

	const onDrop: React.DragEventHandler = useCallback(
		async (e) => {
			if (!FEATURE_DROP_ASSETS_ON_TIMELINE && context === 'timeline') {
				return;
			}

			if (!FEATURE_DROP_ASSETS_ON_CANVAS && context === 'canvas') {
				return;
			}
			e.preventDefault();

			const {current} = playerRef;
			if (!current) {
				throw new Error('playerRef is null');
			}

			const dropPosition: DropPosition | null = null;

			const draggedAssetId = e.dataTransfer.getData(
				EDITOR_ASSET_DRAG_MIME_TYPE,
			);

			if (draggedAssetId) {
				timelineWriteContext.setState({
					update: (prevState) =>
						addAssetToTimeline({
							state: prevState,
							assetId: draggedAssetId,
							currentFrame: playerRef.current?.getCurrentFrame() ?? 0,
							dropPosition,
							resizeCompositionIfEmpty: false,
						}),
					commitToUndoStack: true,
					command: {type: 'item.create'},
				});
				return;
			}

			const uploadPromises = [];
			for (const file of e.dataTransfer.files) {
				uploadPromises.push(
					addAsset({
						file,
						timelineWriteContext: timelineWriteContext,
						filename: file.name,
					}),
				);
			}
			await Promise.all(uploadPromises);

			e.dataTransfer.clearData();
		},
		[context, playerRef, timelineWriteContext],
	);

	const style = useMemo(() => {
		if (context === 'canvas') {
			return {
				padding: CANVAS_PADDING,
			};
		}

		return {};
	}, [context]);

	return (
		<AbsoluteFill onDragOver={onDragOver} onDrop={onDrop} style={style}>
			{children}
		</AbsoluteFill>
	);
};
