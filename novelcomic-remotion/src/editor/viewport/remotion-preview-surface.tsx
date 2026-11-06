import type {PlayerRef} from '@remotion/player';
import {useContext, useMemo} from 'react';
import {EmptyCanvasContextMenuTrigger} from '../canvas/empty-canvas-context-menu-trigger';
import {RemotionPlayer} from '../canvas/player';
import {StateInitializedContext} from '../context-provider';
import {DropHandler} from '../drop-handler';
import {CanvasTransformationContext} from '../utils/canvas-transformation-context';
import type {Rect} from '../utils/fit-element-size-in-container';
import {OverlaySurface} from './overlay-surface';
import {documentRect} from './viewport-math';
import type {ViewportSnapshot} from './viewport-types';

/**
 * Remotion remains the source of truth for composition pixels. This surface
 * only positions the player inside the editor camera and never changes the
 * project state during pointer movement.
 */
export const RemotionPreviewSurface: React.FC<{
	compositionHeight: number;
	compositionWidth: number;
	loop: boolean;
	playerRef: React.RefObject<PlayerRef | null>;
	fps: number;
	canvasSize: Rect | null;
	framesShownInTimeline: number;
	canvasRef: React.RefObject<HTMLDivElement | null>;
	viewport: ViewportSnapshot;
}> = ({
	compositionHeight,
	compositionWidth,
	loop,
	playerRef,
	fps,
	canvasSize,
	framesShownInTimeline,
	canvasRef,
	viewport,
}) => {
	const initialized = useContext(StateInitializedContext);
	const rect = documentRect(
		viewport.viewport,
		viewport.document,
		viewport.transform,
	);
	const canvasTransformation = useMemo(() => {
		if (!canvasSize) {
			return {
				scale: 1,
				xCorrection: 0,
				yCorrection: 0,
				centerX: 0,
				centerY: 0,
			};
		}

		return {
			scale: viewport.transform.zoom,
			xCorrection: ((1 - viewport.transform.zoom) * compositionWidth) / 2,
			yCorrection: ((1 - viewport.transform.zoom) * compositionHeight) / 2,
			centerX:
				canvasSize.width / 2 - (compositionWidth * viewport.transform.zoom) / 2,
			centerY:
				canvasSize.height / 2 -
				(compositionHeight * viewport.transform.zoom) / 2,
		};
	}, [
		canvasSize,
		compositionHeight,
		compositionWidth,
		viewport.transform.zoom,
	]);

	if (!canvasSize || !rect) {
		return null;
	}

	return (
		<EmptyCanvasContextMenuTrigger
			playerRef={playerRef}
			canvasTransformation={canvasTransformation}
			previewSize={{
				size: viewport.transform.zoom,
				translation: {
					x: -viewport.transform.panX,
					y: -viewport.transform.panY,
				},
			}}
			canvasRef={canvasRef}
		>
			<DropHandler playerRef={playerRef} context="canvas">
				<CanvasTransformationContext.Provider value={canvasTransformation}>
					<div
						id="canvas-cover"
						className="canvas-cover"
						tabIndex={-1}
						style={{
							position: 'absolute',
							inset: 0,
							overflow: 'visible',
							opacity: initialized ? 1 : 0,
						}}
					>
						<div
							className="composition-frame"
							style={{
								position: 'absolute',
								left: rect.left,
								top: rect.top,
								width: rect.width,
								height: rect.height,
								backgroundColor: '#000000',
								border: '2px solid #000000',
								boxSizing: 'border-box',
								boxShadow: '0 0 0 1px #262626',
							}}
						>
							<div
								style={{
									position: 'absolute',
									inset: 0,
									overflow: 'hidden',
								}}
							>
								<div
									style={{
										position: 'absolute',
										left: 0,
										top: 0,
										width: compositionWidth,
										height: compositionHeight,
										transform: `scale(${viewport.transform.zoom})`,
										transformOrigin: 'top left',
										display: 'flex',
									}}
								>
									<RemotionPlayer
										compositionHeight={compositionHeight}
										compositionWidth={compositionWidth}
										loop={loop}
										playerRef={playerRef}
										durationInFrames={framesShownInTimeline}
										fps={fps}
									/>
								</div>
							</div>
						</div>
						<OverlaySurface viewport={viewport} />
					</div>
				</CanvasTransformationContext.Provider>
			</DropHandler>
		</EmptyCanvasContextMenuTrigger>
	);
};
