import type {PlayerRef} from '@remotion/player';
import {useContext, useEffect, useRef} from 'react';
import {CanvasSizeProvider} from '../canvas/canvas-size';
import {PreviewSizeContext} from '../preview-size';
import type {Rect} from '../utils/fit-element-size-in-container';
import {RemotionPreviewSurface} from './remotion-preview-surface';
import {ViewportStore, useViewportSnapshot} from './viewport-store';

/** Shared camera host for the main composition editor. */
export const EditorViewport: React.FC<{
	playerRef: React.RefObject<PlayerRef | null>;
	loop: boolean;
	compositionHeight: number;
	compositionWidth: number;
	fps: number;
	durationInFrames: number;
	canvasSize: Rect | null;
	canvasRef: React.RefObject<HTMLDivElement | null>;
	children?: React.ReactNode;
}> = ({
	playerRef,
	loop,
	compositionHeight,
	compositionWidth,
	fps,
	durationInFrames,
	canvasSize,
	canvasRef,
}) => {
	const storeRef = useRef<ViewportStore | null>(null);
	if (!storeRef.current) storeRef.current = new ViewportStore();
	const {size: previewSize} = useContext(PreviewSizeContext);
	const store = storeRef.current;
	const viewport = useViewportSnapshot(store);

	useEffect(() => {
		if (!canvasSize) return;
		store.setViewportSize(
			canvasSize.width,
			canvasSize.height,
			window.devicePixelRatio,
		);
		store.setDocumentSize(compositionWidth, compositionHeight);
		const fitZoom = Math.min(
			canvasSize.width / Math.max(1, compositionWidth),
			canvasSize.height / Math.max(1, compositionHeight),
		);
		if (previewSize.size === 'auto') {
			store.setTransform({
				zoom: fitZoom,
				panX: -previewSize.translation.x,
				panY: -previewSize.translation.y,
			});
		} else {
			store.setTransform({
				zoom: previewSize.size,
				panX: -previewSize.translation.x,
				panY: -previewSize.translation.y,
			});
		}
	}, [canvasSize, compositionHeight, compositionWidth, previewSize, store]);

	return (
		<CanvasSizeProvider size={canvasSize}>
			<RemotionPreviewSurface
				compositionHeight={compositionHeight}
				compositionWidth={compositionWidth}
				loop={loop}
				playerRef={playerRef}
				fps={fps}
				canvasSize={canvasSize}
				framesShownInTimeline={durationInFrames}
				canvasRef={canvasRef}
				viewport={viewport}
			/>
		</CanvasSizeProvider>
	);
};
