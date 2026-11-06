import {useSyncExternalStore} from 'react';
import {ViewportController} from './viewport-controller';
import type {
	Point,
	ViewportSnapshot,
	ViewportTransform,
} from './viewport-types';

/** A small external store keeps pointer-move camera updates out of project state. */
export class ViewportStore {
	readonly controller: ViewportController;
	private listeners = new Set<() => void>();
	private snapshot: ViewportSnapshot;

	constructor(controller = new ViewportController()) {
		this.controller = controller;
		this.snapshot = controller.getSnapshot();
	}

	getSnapshot = () => this.snapshot;

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private publish() {
		this.snapshot = this.controller.getSnapshot();
		for (const listener of this.listeners) listener();
	}

	setViewportSize(width: number, height: number, dpr?: number) {
		this.controller.setViewportSize(width, height, dpr);
		this.publish();
	}

	setDocumentSize(width: number, height: number) {
		this.controller.setDocumentSize(width, height);
		this.publish();
	}

	setTransform(transform: Partial<ViewportTransform>) {
		this.controller.setTransform(transform);
		this.publish();
	}

	panBy(delta: Point) {
		this.controller.panBy(delta);
		this.publish();
	}

	zoomAt(point: Point, zoom: number) {
		this.controller.zoomAt(point, zoom);
		this.publish();
	}

	zoomKeyboard(direction: -1 | 1, anchor?: Point) {
		this.controller.zoomKeyboard(direction, anchor);
		this.publish();
	}

	fit(padding?: number) {
		this.controller.fit(padding);
		this.publish();
	}

	actualPixels() {
		this.controller.actualPixels();
		this.publish();
	}
}

export const useViewportSnapshot = (store: ViewportStore) =>
	useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
