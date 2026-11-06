import type {MarqueeMode} from '../../document/selection-geometry';
import type {LassoKind} from './lasso-settings';

const cursor = (svg: string, x: number, y: number, fallback: string) =>
	`url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;

const crosshair = () =>
	`<g fill="none" stroke-linecap="round"><path d="M8 1.2V6.2M8 9.8V14.8M1.2 8H6.2M9.8 8H14.8" stroke="#fff" stroke-width="2.6"/><path d="M8 1.2V6.2M8 9.8V14.8M1.2 8H6.2M9.8 8H14.8" stroke="#000" stroke-width="1.15"/></g>`;

/** PolygonalLassoToolIcon on its 18-unit grid, fitted in the 12px badge under the crosshair. */
const polygonalIcon = () => {
	const unit = 12 / 18;
	const point = (x: number, y: number) => `${(15 + x * unit).toFixed(2)},${(15 + y * unit).toFixed(2)}`;
	const loop = [point(1.2, 7), point(4, 2.4), point(11.8, 1.8), point(16.8, 5.2), point(15.6, 10.4), point(7, 11.6)].join(' ');
	const knot = [point(8.9, 10.9), point(13.3, 10.5), point(11.6, 14.5)].join(' ');
	const rope = [point(11.6, 14.5), point(12.9, 17.3)].join(' ');
	return `<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M${loop}Z M${knot}Z M${rope}" stroke="#fff" stroke-width="2.9"/><path d="M${loop}Z M${knot}Z M${rope}" stroke="#000" stroke-width="0.93"/></g>`;
};

const freehandIcon = () =>
	`<g fill="none" stroke-linecap="round" stroke-linejoin="round" transform="translate(15 15)"><path d="M1.4 7.2C1.4 3.4 4.6 1.6 7.8 2.6C11 3.6 11.2 7.2 8.8 8.4C7.2 9.2 5.6 8.2 5.8 6.8L8.4 11.4" stroke="#fff" stroke-width="2.9"/><path d="M1.4 7.2C1.4 3.4 4.6 1.6 7.8 2.6C11 3.6 11.2 7.2 8.8 8.4C7.2 9.2 5.6 8.2 5.8 6.8L8.4 11.4" stroke="#000" stroke-width="1.15"/></g>`;

const modeBadge = (mode: MarqueeMode) => {
	if (mode === 'replace') return '';
	const mark = mode === 'add' ? 'M32 18V24M29 21H35' : 'M29 21H35';
	return `<g fill="none" stroke-linecap="round"><path d="${mark}" stroke="#fff" stroke-width="3.2"/><path d="${mark}" stroke="#000" stroke-width="1.2"/></g>`;
};

const drawSvg = (outline: LassoKind, mode: MarqueeMode) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="32" viewBox="0 0 40 32">${crosshair()}${outline === 'polygonal' ? polygonalIcon() : freehandIcon()}${modeBadge(mode)}</svg>`;

const moveSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M5 4L5 20.5L8.9 16.8L11.6 23L14.2 21.9L11.6 15.8L16.8 15.8Z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><rect x="14.5" y="17.5" width="8" height="6" fill="none" stroke="#fff" stroke-width="2.5"/><rect x="14.5" y="17.5" width="8" height="6" fill="none" stroke="#000" stroke-width="1" stroke-dasharray="2 1.5"/></svg>`;

const drawCursors: Record<LassoKind, Record<MarqueeMode, string>> = {
	freehand: {
		replace: cursor(drawSvg('freehand', 'replace'), 8, 8, 'crosshair'),
		add: cursor(drawSvg('freehand', 'add'), 8, 8, 'crosshair'),
		subtract: cursor(drawSvg('freehand', 'subtract'), 8, 8, 'crosshair'),
	},
	polygonal: {
		replace: cursor(drawSvg('polygonal', 'replace'), 8, 8, 'crosshair'),
		add: cursor(drawSvg('polygonal', 'add'), 8, 8, 'crosshair'),
		subtract: cursor(drawSvg('polygonal', 'subtract'), 8, 8, 'crosshair'),
	},
};

/** Crosshair with the rail icon, and a + or − when the outline will add or subtract. */
export const lassoDrawCursor = (outline: LassoKind, mode: MarqueeMode) => drawCursors[outline][mode];

/** Arrow with a dashed box: dragging here moves the selection outline, not its pixels. */
export const lassoMoveCursor = cursor(moveSvg, 5, 4, 'default');
