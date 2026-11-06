/** CanvasViewport.zoomRange 0.001...32, shown as 0.1%–3200%. */
export const MIN_ZOOM_PERCENT = 0.1;
export const MAX_ZOOM_PERCENT = 3200;

/**
 * NavigationToolHeader.syncZoom: two decimals, then strip trailing zeros.
 * 100.00 → 100, 12.50 → 12.5, 66.67 stays 66.67.
 */
export const formatZoomPercent = (zoom: number) =>
	(zoom * 100).toFixed(2).replace(/\.?0+$/, '');

/**
 * Status bar percent, matching `Text(zoom, format: .percent.precision(.fractionLength(0...1)))`.
 */
export const formatStatusZoom = (zoom: number) => {
	const rounded = Math.round(zoom * 1000) / 10;
	return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
};

export const clampZoomPercent = (percent: number) =>
	Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, percent));

/**
 * NavigationToolHeader.applyZoom. Empty, non-numeric, and non-positive text is ignored.
 * The viewport clamps the resulting factor to 0.001...32.
 */
export const zoomFromPercentText = (text: string) => {
	const cleaned = text.trim().replaceAll('%', '');
	if (!cleaned) return null;
	const value = Number(cleaned);
	if (!Number.isFinite(value) || value <= 0) return null;
	return value / 100;
};
