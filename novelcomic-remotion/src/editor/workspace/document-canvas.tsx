'use client';
import React, {useEffect, useRef, useState} from 'react';
import {
	brushPreviewSource,
	brushSourceCanvas,
	getBrushPreviewRevision,
	noteLoadedRaster,
	subscribeBrushPreview,
} from '../tools/brush/brush-pixels';
import {
	getBrushToolSettings,
	subscribeBrushToolSettings,
} from '../tools/brush/brush-settings';
import {getCloneSettings, subscribeCloneSettings} from '../tools/brush/clone-stamp';
import {buildRenderGraph} from '../render-graph/build-render-graph';
import {RenderGraphRenderer} from '../render-graph/renderer';
import {ACTIVE_SELECTION_ID, selectAllShape, selectionRecord} from '../document/selection-geometry';
import {
	getLassoToolSettings,
	subscribeLassoToolSettings,
} from '../tools/lasso/lasso-settings';
import {
	getMarqueeToolSettings,
	subscribeMarqueeToolSettings,
} from '../tools/marquee/marquee-settings';
import {ToolOverlayRoot} from '../tools/overlays/tool-overlay-root';
import {normalizePointerEvent} from '../tools/pointer-event';
import {resolveToolCapability} from '../tools/tool-capabilities';
import {
	getMoveToolSettings,
	subscribeMoveToolSettings,
} from '../tools/move/move-tool-settings';
import {ToolController} from '../tools/tool-controller';
import {getToolDefinition} from '../tools/tool-registry';
import type {ToolOverlayState} from '../tools/types';
import {pinchZoom, wheelPan, wheelZoom} from '../viewport/viewport-gestures';
import {documentRect} from '../viewport/viewport-math';
import {ViewportStore, useViewportSnapshot} from '../viewport/viewport-store';
import {useDocumentWorkspace} from './document-workspace-context';
const imageCache = new Map<string, HTMLImageElement>();
const loadAsset = (
	url: string | undefined,
	assetId?: string,
): Promise<HTMLImageElement | undefined> => {
	if (!url || typeof Image === 'undefined') return Promise.resolve(undefined);
	const cached = imageCache.get(url);
	const note = (image: HTMLImageElement) => {
		if (assetId && image.naturalWidth > 0) noteLoadedRaster(assetId, image, image.naturalWidth, image.naturalHeight);
	};
	if (cached?.complete) {
		note(cached);
		return Promise.resolve(cached);
	}
	const image = cached ?? new Image();
	image.crossOrigin = 'anonymous';
	image.src = url;
	imageCache.set(url, image);
	return new Promise((resolve) => {
		image.onload = () => {
			note(image);
			resolve(image);
		};
		image.onerror = () => resolve(undefined);
	});
};
export const DocumentCanvas: React.FC<{viewportStore: ViewportStore}> = ({
	viewportStore,
}) => {
	const {
		document,
		selectedLayerIds,
		activeLayerId,
		setSelection,
		setSelectedIds,
		clearSelection,
		commitSelection,
		dispatch,
		dispatchCommands,
		tool,
		movePreview,
		setMovePreview,
	} = useDocumentWorkspace();
	const hostRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const rendererRef = useRef<RenderGraphRenderer | null>(null);
	const controllerRef = useRef<ToolController | null>(null);
	const [overlay, setOverlay] = useState<ToolOverlayState | null>(null);
	const snapshot = useViewportSnapshot(viewportStore);
	const moveSettings = React.useSyncExternalStore(
		subscribeMoveToolSettings,
		getMoveToolSettings,
		getMoveToolSettings,
	);
	const marqueeSettings = React.useSyncExternalStore(
		subscribeMarqueeToolSettings,
		getMarqueeToolSettings,
		getMarqueeToolSettings,
	);
	const lassoSettings = React.useSyncExternalStore(
		subscribeLassoToolSettings,
		getLassoToolSettings,
		getLassoToolSettings,
	);
	const brushSettings = React.useSyncExternalStore(
		subscribeBrushToolSettings,
		getBrushToolSettings,
		getBrushToolSettings,
	);
	const cloneSettings = React.useSyncExternalStore(subscribeCloneSettings, getCloneSettings, getCloneSettings);
	const brushRevision = React.useSyncExternalStore(
		subscribeBrushPreview,
		getBrushPreviewRevision,
		getBrushPreviewRevision,
	);
	const shown = movePreview ?? document;
	const temporaryToolRef = useRef<typeof tool | null>(null);
	const middleHandRef = useRef<typeof tool | null>(null);
	const context = {
		document: shown,
		selectedLayerIds,
		activeLayerId,
		viewport: snapshot,
		setSelection,
		setSelectedIds,
		clearSelection,
		setMovePreview,
		commitSelection,
		dispatch,
		dispatchCommands,
		setViewportPan: (delta: {x: number; y: number}) =>
			viewportStore.panBy(delta),
		setViewportZoom: (point: {x: number; y: number}, zoom: number) =>
			viewportStore.zoomAt(point, zoom),
		getViewport: () => viewportStore.getSnapshot(),
		notifyOverlay: () => setOverlay(controllerRef.current?.getOverlayState() ?? null),
		getCapability: (toolId: typeof tool) =>
			resolveToolCapability(
				toolId,
				{document, activeLayerId, selectedLayerIds},
				getToolDefinition(toolId).requirements,
			),
		sampleComposite: (point: {x: number; y: number}) =>
			rendererRef.current?.readDocumentPixel(point.x, point.y) ?? null,
	};
	if (!controllerRef.current)
		controllerRef.current = new ToolController(context);
	const controller = controllerRef.current;
	controller.updateContext(context);
	useEffect(() => {
		controller.activate(tool);
	}, [controller, tool]);
	useEffect(() => {
		setOverlay(controller.getOverlayState());
	}, [
		activeLayerId,
		controller,
		document,
		movePreview,
		brushSettings,
		cloneSettings,
		lassoSettings,
		marqueeSettings,
		moveSettings,
		selectedLayerIds,
		tool,
	]);
	useEffect(() => () => controller.dispose(), [controller]);
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const update = () => {
			const rect = host.getBoundingClientRect();
			viewportStore.setViewportSize(
				rect.width,
				rect.height,
				window.devicePixelRatio,
			);
			viewportStore.setDocumentSize(document.width, document.height);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(host);
		window.addEventListener('resize', update);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', update);
		};
	}, [document.height, document.width, viewportStore]);
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		if (!rendererRef.current) rendererRef.current = new RenderGraphRenderer(canvas);
		const renderer = rendererRef.current;
		renderer.setAssetLoader((assetId) =>
			brushPreviewSource(assetId) ??
			brushSourceCanvas(assetId) ??
			loadAsset(shown.assets[assetId]?.objectKey, assetId),
		);
		void renderer.render(
			buildRenderGraph({document: shown, frame: 0, quality: 'preview'}),
		);
	}, [brushRevision, shown]);
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			const typing = Boolean(
				target?.closest('input, textarea, select, [contenteditable="true"]'),
			);
			if (typing && event.key !== 'Escape') return;
			if (event.key === ' ' && !temporaryToolRef.current) {
				event.preventDefault();
				// A stroke already in progress is left alone. Switching tools here would
				// cancel it, which Compositor does not do.
				if (!controller.suspendFor('hand')) return;
				temporaryToolRef.current = tool;
				setOverlay(controller.getOverlayState());
				return;
			}
			const modifier = event.metaKey || event.ctrlKey;
			if (modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd') {
				event.preventDefault();
				if (document.selections[ACTIVE_SELECTION_ID]) commitSelection(null);
				return;
			}
			if (modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') {
				event.preventDefault();
				commitSelection(selectionRecord(selectAllShape(document.width, document.height)));
				return;
			}
			const pageZoomed = Math.abs((window.visualViewport?.scale ?? 1) - 1) > 0.001;
			if (pageZoomed && modifier && (event.key === '=' || event.key === '+' || event.key === '-' || event.key === '_' || event.key === '0')) {
				return;
			}
			if (modifier && (event.key === '=' || event.key === '+' || event.key === '-' || event.key === '_')) {
				event.preventDefault();
				const bounds = hostRef.current?.getBoundingClientRect();
				viewportStore.zoomKeyboard(event.key === '-' || event.key === '_' ? -1 : 1, bounds ? {x: bounds.width / 2, y: bounds.height / 2} : undefined);
				return;
			}
			if (modifier && !event.shiftKey && event.key === '0') {
				event.preventDefault();
				viewportStore.fit();
				return;
			}
			if (modifier && !event.shiftKey && event.key === '1') {
				event.preventDefault();
				viewportStore.actualPixels();
				return;
			}
			if (
				controller.keyDown({
					key: event.key,
					modifiers: {
						shift: event.shiftKey,
						alt: event.altKey,
						meta: event.metaKey,
						control: event.ctrlKey,
						space: event.key === ' ',
					},
				})
			) {
				event.preventDefault();
				setOverlay(controller.getOverlayState());
			}
		};
		const onKeyUp = (event: KeyboardEvent) => {
			if (
				controller.keyUp({
					key: event.key,
					modifiers: {
						shift: event.shiftKey,
						alt: event.altKey,
						meta: event.metaKey,
						control: event.ctrlKey,
						space: false,
					},
				})
			) {
				setOverlay(controller.getOverlayState());
			}
			if (event.key === ' ' && temporaryToolRef.current) {
				const restore = temporaryToolRef.current;
				temporaryToolRef.current = null;
				if (!controller.resume()) controller.activate(restore);
				setOverlay(controller.getOverlayState());
			}
		};
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		return () => {
		window.removeEventListener('keydown', onKeyDown);
		window.removeEventListener('keyup', onKeyUp);
		};
	}, [commitSelection, controller, document, tool, viewportStore]);
	useEffect(() => {
		let gestureZoom = 1;
		const canvasPoint = (clientX: number, clientY: number) => {
			const host = hostRef.current;
			if (!host) return null;
			const bounds = host.getBoundingClientRect();
			const over =
				clientX >= bounds.left &&
				clientX <= bounds.right &&
				clientY >= bounds.top &&
				clientY <= bounds.bottom;
			return {
				over,
				anchor: over
					? {x: clientX - bounds.left, y: clientY - bounds.top}
					: {x: bounds.width / 2, y: bounds.height / 2},
			};
		};
		const onWheel = (event: WheelEvent) => {
			if (Math.abs((window.visualViewport?.scale ?? 1) - 1) > 0.001) return;
			const hit = canvasPoint(event.clientX, event.clientY);
			if (!hit) return;
			const commandOrOption = event.metaKey || event.altKey;
			const pinch = event.ctrlKey && !commandOrOption;
			if (!pinch && !hit.over) return;
			event.preventDefault();
			const current = viewportStore.getSnapshot().transform.zoom;
			if (pinch) {
				viewportStore.zoomAt(hit.anchor, pinchZoom(current, event.deltaY));
				return;
			}
			if (commandOrOption) {
				viewportStore.zoomAt(hit.anchor, wheelZoom(current, event.deltaY));
				return;
			}
			const precise = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL;
			viewportStore.panBy(wheelPan(event.deltaX, event.deltaY, precise));
		};
		const onGestureStart = (event: Event) => {
			if (Math.abs((window.visualViewport?.scale ?? 1) - 1) > 0.001) return;
			event.preventDefault();
			gestureZoom = viewportStore.getSnapshot().transform.zoom;
		};
		const onGestureChange = (event: Event) => {
			if (Math.abs((window.visualViewport?.scale ?? 1) - 1) > 0.001) return;
			event.preventDefault();
			const host = hostRef.current;
			if (!host) return;
			const bounds = host.getBoundingClientRect();
			const scale = (event as Event & {scale?: number}).scale ?? 1;
			viewportStore.zoomAt({x: bounds.width / 2, y: bounds.height / 2}, gestureZoom * scale);
		};
		window.addEventListener('wheel', onWheel, {capture: true, passive: false});
		window.addEventListener('gesturestart', onGestureStart, {passive: false});
		window.addEventListener('gesturechange', onGestureChange, {passive: false});
		return () => {
			window.removeEventListener('wheel', onWheel, {capture: true});
			window.removeEventListener('gesturestart', onGestureStart);
			window.removeEventListener('gesturechange', onGestureChange);
		};
	}, [viewportStore]);
	const eventFor = (event: React.PointerEvent<HTMLDivElement>) => {
		const rect = hostRef.current?.getBoundingClientRect();
		return rect ? normalizePointerEvent(event, rect, snapshot) : null;
	};
	const onDown = (event: React.PointerEvent<HTMLDivElement>) => {
		if (event.button === 1) {
			if (!controller.suspendFor('hand')) return;
			middleHandRef.current = tool;
		}
		if (event.button === 2 && tool !== 'brush' && tool !== 'healing' && tool !== 'clone-stamp') return;
		if (event.button > 2) return;
		const value = eventFor(event);
		if (!value || !controller.pointerDown(value)) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		setOverlay(controller.getOverlayState());
	};
	const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
		const value = eventFor(event);
		if (!value) return;
		controller.pointerMove(value);
		setOverlay(controller.getOverlayState());
	};
	const onUp = (event: React.PointerEvent<HTMLDivElement>) => {
		const value = eventFor(event);
		if (!value) return;
		controller.pointerUp(value);
		if (event.currentTarget.hasPointerCapture(event.pointerId))
			event.currentTarget.releasePointerCapture(event.pointerId);
		if (middleHandRef.current) {
			const restore = middleHandRef.current;
			middleHandRef.current = null;
			if (!controller.resume()) controller.activate(restore);
		}
		setOverlay(controller.getOverlayState());
	};
	const onCancel = (reason: 'pointercancel' | 'lostpointercapture') => {
		controller.pointerCancel(reason);
		setOverlay(controller.getOverlayState());
	};
	const rect = documentRect(snapshot.viewport, snapshot.document, snapshot.transform);
	const zoom = snapshot.transform.zoom;
	return (
		<div
			ref={hostRef}
			className="absolute inset-0 touch-none overflow-hidden bg-[#1b1b1b]"
			aria-label="文档画布"
			data-testid="document-canvas"
			style={{cursor: overlay?.canvasCursor ?? controller.cursor, contain: 'paint'}}
			onPointerDown={onDown}
			onPointerMove={onMove}
			onPointerUp={onUp}
			onPointerCancel={() => onCancel('pointercancel')}
			onLostPointerCapture={() => onCancel('lostpointercapture')}
			onContextMenu={(event) => {
				if (tool === 'brush' || tool === 'healing' || tool === 'clone-stamp') event.preventDefault();
			}}
		>
			<div
				aria-hidden
				className="pointer-events-none absolute shadow-[0_3px_14px_rgba(0,0,0,.45)] outline outline-1 outline-black/45"
				style={{
					left: rect.left,
					top: rect.top,
					width: rect.width,
					height: rect.height,
					backgroundColor: '#d0d0d0',
					backgroundImage:
						'linear-gradient(45deg, #b8b8b8 25%, transparent 25%), linear-gradient(-45deg, #b8b8b8 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #b8b8b8 75%), linear-gradient(-45deg, transparent 75%, #b8b8b8 75%)',
					backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
					backgroundSize: '16px 16px',
				}}
			/>
			<div
				data-testid="document-surface"
				className="absolute top-0 left-0"
				style={{
					width: snapshot.document.width,
					height: snapshot.document.height,
					transformOrigin: '0 0',
					transform: `translate(${rect.left}px, ${rect.top}px) scale(${zoom})`,
				}}
			>
				<canvas
					ref={canvasRef}
					width={document.width}
					height={document.height}
					className="block touch-none"
					style={{
						cursor: 'inherit',
						width: snapshot.document.width,
						height: snapshot.document.height,
						imageRendering: zoom >= 2 ? 'pixelated' : 'auto',
					}}
					aria-label="文档内容"
				/>
			</div>
			<div
				className="pointer-events-none absolute"
				style={{left: rect.left, top: rect.top, width: rect.width, height: rect.height}}
			>
				<ToolOverlayRoot
					state={overlay}
					scale={zoom}
					selection={
						overlay && Object.prototype.hasOwnProperty.call(overlay, 'selectionPreview')
							? overlay.selectionPreview
							: (document.selections[ACTIVE_SELECTION_ID] ?? null)
					}
				/>
			</div>
		</div>
	);
};
