/**
 * EditorCanvas.scrollWheel and magnify(with:).
 *
 * AppKit `scrollingDeltaY` is positive when the user scrolls up. A browser
 * `WheelEvent.deltaY` is positive when the user scrolls down. Compositor zooms
 * with `zoom * exp(-scrollingDeltaY * 0.015)` while Command or Option is held,
 * so scrolling down zooms in about the pointer. The browser delta is negated
 * once to land on that same exponent.
 *
 * A classic wheel reports lines and is scaled by 12 for panning. A trackpad
 * reports pixels and is used as-is. Pinch-to-zoom arrives as ctrl+wheel, which
 * is the web stand-in for `magnify(with:)`: fingers apart zoom in.
 */
export const wheelZoom = (zoom: number, deltaY: number) => zoom * Math.exp(deltaY * 0.015);

/** ctrl+wheel stand-in for `zoom * (1 + magnification)`. Negative deltaY zooms in. */
export const pinchZoom = (zoom: number, deltaY: number) => zoom * Math.exp(-deltaY * 0.015);

export const wheelPan = (deltaX: number, deltaY: number, precise: boolean) => {
	const multiplier = precise ? 1 : 12;
	return {x: -deltaX * multiplier, y: -deltaY * multiplier};
};
