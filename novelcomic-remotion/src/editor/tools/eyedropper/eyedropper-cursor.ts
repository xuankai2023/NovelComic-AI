const cursor = (svg: string, x: number, y: number, fallback: string) =>
	`url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;

/**
 * Compositor's eyedropper cursor: a dropper with a white rim and a black core.
 * The tip is the hot spot, at the glyph's bottom left (EditorCanvas.makeEyedropperCursor).
 */
const paths = `<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3L15 6"/>`;

const badge = (kind: 'add' | 'remove') =>
	kind === 'add'
		? `<circle cx="18.5" cy="18.5" r="4.2" fill="#fff" stroke="#000" stroke-width="1"/><path d="M18.5 16.6v3.8M16.6 18.5h3.8" stroke="#000" stroke-width="1.2" stroke-linecap="round"/>`
		: `<circle cx="18.5" cy="18.5" r="4.2" fill="#fff" stroke="#000" stroke-width="1"/><path d="M16.6 18.5h3.8" stroke="#000" stroke-width="1.2" stroke-linecap="round"/>`;

/** Add and Remove carry the + or − badge Color Range shows on its eyedropper. */
export const eyedropperCursorWith = (kind?: 'add' | 'remove') => {
	const mark = kind ? badge(kind) : '';
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#fff" stroke-width="4.2">${paths}</g><g stroke="#000" stroke-width="1.6">${paths}</g></g>${mark}</svg>`;
	return cursor(svg, 2, 22, 'crosshair');
};

export const eyedropperCursor = eyedropperCursorWith();
