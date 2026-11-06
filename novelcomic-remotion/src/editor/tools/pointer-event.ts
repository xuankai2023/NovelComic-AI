import {clientToViewport, viewportToDocument} from './coordinates';
import {modifiersFromPointer} from './modifiers';
import type {ToolPointerEvent, ToolPoint} from './types';
import type {ViewportSnapshot} from '../viewport/viewport-types';

export type {ToolModifiers, ToolPointerEvent} from './types';

export const normalizePressure = (pressure: number) => pressure > 0 ? pressure : 1;

export const normalizePointerEvent = (event: {pointerId: number; pointerType: string; buttons: number; pressure: number; clientX: number; clientY: number; detail?: number; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean}, hostRect: DOMRectReadOnly, snapshot: ViewportSnapshot, space = false): ToolPointerEvent => {
	const clientPoint: ToolPoint = {x: event.clientX, y: event.clientY};
	const viewportPoint = clientToViewport(clientPoint, hostRect);
	return {pointerId: event.pointerId, pointerType: event.pointerType, buttons: event.buttons, pressure: normalizePressure(event.pressure), clickCount: Math.max(1, event.detail ?? 1), clientPoint, viewportPoint, documentPoint: viewportToDocument(viewportPoint, snapshot), modifiers: modifiersFromPointer(event, space)};
};
