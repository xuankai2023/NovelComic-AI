import {
	documentRect,
	documentToScreen,
	screenToDocument,
} from './viewport-math';
import type {
	Point,
	ViewportSize,
	ViewportSnapshot,
	ViewportTransform,
} from './viewport-types';

export const MIN_VIEWPORT_ZOOM = 0.001;
export const MAX_VIEWPORT_ZOOM = 32;

export const KEYBOARD_ZOOM_LEVELS = [
	MIN_VIEWPORT_ZOOM,
	0.05,
	0.125,
	1 / 6,
	0.25,
	1 / 3,
	0.5,
	2 / 3,
	1,
	1.25,
	1.5,
	2,
	3,
	4,
	5,
	6,
	8,
	12,
	16,
	MAX_VIEWPORT_ZOOM,
];

const clampZoom = (zoom: number) =>
	Math.max(MIN_VIEWPORT_ZOOM, Math.min(MAX_VIEWPORT_ZOOM, zoom));

export class ViewportController {
	private viewport: ViewportSize = {width: 0, height: 0};
	private document: ViewportSize = {width: 1, height: 1};
	private followsFit = true;
	private transform: ViewportTransform = {
		zoom: 1,
		panX: 0,
		panY: 0,
		rotation: 0,
		devicePixelRatio: 1,
	};

	setViewportSize(
		width: number,
		height: number,
		devicePixelRatio = this.transform.devicePixelRatio,
	) {
		this.viewport = {width: Math.max(0, width), height: Math.max(0, height)};
		this.transform = {
			...this.transform,
			devicePixelRatio: Number.isFinite(devicePixelRatio)
				? Math.max(1, devicePixelRatio)
				: 1,
		};
		if (this.followsFit) this.fit();
	}

	setDocumentSize(width: number, height: number) {
		this.document = {width: Math.max(1, width), height: Math.max(1, height)};
		if (this.followsFit) this.fit();
	}

	getViewportSize() {
		return {...this.viewport};
	}

	getDocumentSize() {
		return {...this.document};
	}

	getTransform() {
		return {...this.transform};
	}

	getSnapshot(): ViewportSnapshot {
		return {
			viewport: this.getViewportSize(),
			document: this.getDocumentSize(),
			transform: this.getTransform(),
			followsFit: this.followsFit,
			pointsPerPixel: this.transform.zoom,
		};
	}

	setTransform(next: Partial<ViewportTransform>) {
		this.followsFit = false;
		this.transform = {
			...this.transform,
			...next,
			zoom: clampZoom(next.zoom ?? this.transform.zoom),
			// Rotation is a deliberate phase-one invariant.
			rotation: 0,
		};
	}

	fit(padding = 48) {
		this.followsFit = true;
		const availableWidth = Math.max(1, this.viewport.width - padding * 2);
		const availableHeight = Math.max(1, this.viewport.height - padding * 2);
		this.transform = {
			...this.transform,
			zoom: clampZoom(
				Math.min(
					availableWidth / this.document.width,
					availableHeight / this.document.height,
				),
			),
			panX: 0,
			panY: 0,
		};
	}

	actualPixels() {
		this.followsFit = false;
		this.transform = {...this.transform, zoom: 1, panX: 0, panY: 0};
	}

	panBy(delta: Point) {
		this.followsFit = false;
		this.transform = {
			...this.transform,
			panX: this.transform.panX + delta.x,
			panY: this.transform.panY + delta.y,
		};
	}

	zoomAt(screenPoint: Point, nextZoom: number) {
		this.followsFit = false;
		const next = clampZoom(nextZoom);
		const before = this.screenToDocument(screenPoint);
		this.transform = {...this.transform, zoom: next};
		const after = this.documentToScreen(before);
		this.transform = {
			...this.transform,
			panX: this.transform.panX + screenPoint.x - after.x,
			panY: this.transform.panY + screenPoint.y - after.y,
		};
	}

	keyboardZoomTarget(direction: -1 | 1) {
		const current = this.transform.zoom;
		if (direction > 0)
			return KEYBOARD_ZOOM_LEVELS.find((level) => level > current + 1e-7) ?? current;
		return [...KEYBOARD_ZOOM_LEVELS].reverse().find((level) => level < current - 1e-7) ?? current;
	}

	zoomKeyboard(direction: -1 | 1, anchor?: Point) {
		const point = anchor ?? {
			x: this.viewport.width / 2,
			y: this.viewport.height / 2,
		};
		this.zoomAt(point, this.keyboardZoomTarget(direction));
	}

	screenToDocument(point: Point) {
		return screenToDocument(
			point,
			this.viewport,
			this.document,
			this.transform,
		);
	}

	documentToScreen(point: Point) {
		return documentToScreen(
			point,
			this.viewport,
			this.document,
			this.transform,
		);
	}

	getDocumentRect() {
		return documentRect(this.viewport, this.document, this.transform);
	}
}
