import {useEffect, useRef} from 'react';
import type {ViewportSnapshot} from './viewport-types';

/**
 * Editor-only drawing surface. It is deliberately a sibling of Remotion's
 * Player so selection handles, paths and guides can never leak into export.
 * Pointer tools may opt into this layer later without changing composition DOM.
 */
export const OverlaySurface: React.FC<{
	viewport: ViewportSnapshot;
	className?: string;
}> = ({viewport, className}) => {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const dpr = Math.max(1, viewport.transform.devicePixelRatio);
		canvas.width = Math.max(1, Math.round(viewport.viewport.width * dpr));
		canvas.height = Math.max(1, Math.round(viewport.viewport.height * dpr));
		canvas.style.width = `${viewport.viewport.width}px`;
		canvas.style.height = `${viewport.viewport.height}px`;
		const context = canvas.getContext('2d');
		if (!context) return;
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		context.clearRect(0, 0, viewport.viewport.width, viewport.viewport.height);
	}, [viewport]);

	return (
		<canvas
			ref={canvasRef}
			aria-hidden="true"
			className={className}
			style={{
				position: 'absolute',
				inset: 0,
				pointerEvents: 'none',
			}}
		/>
	);
};
