import type {MarqueeMode} from '../../document/selection-geometry';
import {lassoMoveCursor} from '../lasso/lasso-cursors';

const cursor = (svg: string, x: number, y: number, fallback: string) =>
	`url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;

/** Compositor's wand cursor: sparkle hotspot, stick, and a + or − badge. */
const wandSvg = (mode: MarqueeMode) => {
	const badge =
		mode === 'replace'
			? ''
			: mode === 'add'
				? '<path d="M21 12H27M24 9V15" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><path d="M21 12H27M24 9V15" stroke="#000" stroke-width="1.2" stroke-linecap="round"/>'
				: '<path d="M21 12H27" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><path d="M21 12H27" stroke="#000" stroke-width="1.2" stroke-linecap="round"/>';
	return `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34" fill="none"><path d="M13 13L27 27" stroke="#fff" stroke-width="5" stroke-linecap="round"/><path d="M7 1V4.5M7 9.5V13M1 7H4.5M9.5 7H13" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>${badge}<path d="M13 13L27 27" stroke="#000" stroke-width="2.4" stroke-linecap="round"/><path d="M7 1V4.5M7 9.5V13M1 7H4.5M9.5 7H13" stroke="#000" stroke-width="1.2" stroke-linecap="round"/></svg>`;
};

const drawCursors: Record<MarqueeMode, string> = {
	replace: cursor(wandSvg('replace'), 7, 7, 'crosshair'),
	add: cursor(wandSvg('add'), 7, 7, 'crosshair'),
	subtract: cursor(wandSvg('subtract'), 7, 7, 'crosshair'),
};

export const wandDrawCursor = (mode: MarqueeMode) => drawCursors[mode];

/** Arrow with a dashed box: dragging here moves the selection outline. */
export const wandMoveCursor = lassoMoveCursor;
