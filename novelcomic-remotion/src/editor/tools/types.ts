import type {DocumentCommand, DocumentCommandPayloads, DocumentCommandType} from '../commands/document-command-types';
import type {DocumentState, SelectionRecord} from '../document/types';
import type {ViewportSnapshot} from '../viewport/viewport-types';

export type WorkspaceToolId =
	| 'move' | 'marquee-rectangle' | 'marquee-ellipse' | 'lasso' | 'polygon-lasso'
	| 'magic-wand' | 'color-range' | 'object-select' | 'select-subject'
	| 'brush' | 'eraser' | 'blur' | 'smudge' | 'liquify' | 'clone-stamp' | 'healing'
	| 'gradient' | 'eyedropper' | 'shape' | 'type' | 'hand' | 'zoom';

export type ToolPoint = {x: number; y: number};
export type ToolModifiers = {shift: boolean; alt: boolean; meta: boolean; control: boolean; space: boolean};
export type ToolPointerEvent = {
	pointerId: number;
	pointerType: string;
	buttons: number;
	pressure: number;
	clickCount?: number;
	clientPoint: ToolPoint;
	viewportPoint: ToolPoint;
	documentPoint: ToolPoint;
	modifiers: ToolModifiers;
};
export type ToolKeyEvent = {key: string; modifiers: ToolModifiers; repeat?: boolean};
export type ToolSessionStatus = 'idle' | 'active' | 'committed' | 'cancelled' | 'disposed';
export type ToolCancelReason = 'escape' | 'pointercancel' | 'lostpointercapture' | 'tool-switch' | 'unmount' | 'capability' | 'unknown';
export type ToolCursor = 'default' | 'pointer' | 'crosshair' | 'grab' | 'grabbing' | 'zoom-in' | 'zoom-out' | 'not-allowed';
export type ToolRequirement = 'document' | 'active-layer' | 'editable-layer' | 'selection' | 'implemented';
export type ToolCapability = {enabled: true} | {enabled: false; reason: string};

export type ToolOverlayState = {
	selectionDraft?: {
		kind: 'rectangle' | 'ellipse' | 'lasso';
		points?: ToolPoint[];
		bounds?: {x: number; y: number; width: number; height: number};
		/** Polygonal rubber-band end. It is not part of the outline until the next click. */
		cursor?: ToolPoint | null;
		polygonal?: boolean;
	} | null;
	/** While an outline is being moved, this replaces the committed selection in the overlay. */
	selectionPreview?: SelectionRecord | null;
	transform?: {corners: ToolPoint[]; handles: Array<{kind: string; point: ToolPoint}>; rotationHandle?: ToolPoint} | null;
	snapGuides?: Array<{orientation: 'horizontal' | 'vertical'; position: number}>;
	cursor?: {point: ToolPoint; cursor: ToolCursor} | null;
	canvasCursor?: string;
	/**
	 * Brush tip in document pixels. `hardness` draws the inner ring while it is being dragged.
	 * Clone Stamp adds the source crosshair and a preview of what a click would stamp.
	 */
	brushCursor?: {
		x: number;
		y: number;
		diameter: number;
		hardness?: number;
		sample?: {x: number; y: number};
		preview?: {width: number; height: number; data: Uint8ClampedArray; opacity: number};
	} | null;
};

export type ToolSessionContext = {
	document: DocumentState;
	selectedLayerIds: readonly string[];
	activeLayerId: string | null;
	viewport: ViewportSnapshot;
	setSelection: (layerId: string, additive?: boolean) => void;
	setSelectedIds?: (layerIds: string[]) => void;
	clearSelection: () => void;
	setMovePreview?: (document: DocumentState | null) => void;
	commitSelection: (selection: SelectionRecord | null) => void;
	dispatch: <TType extends DocumentCommandType>(type: TType, payload: DocumentCommandPayloads[TType], options?: Pick<DocumentCommand, 'mergeKey' | 'transactionId'>) => void;
	dispatchCommands: (commands: readonly DocumentCommand[]) => void;
	setViewportPan: (delta: ToolPoint) => void;
	setViewportZoom: (point: ToolPoint, zoom: number) => void;
	getViewport?: () => ViewportSnapshot;
	notifyOverlay?: () => void;
	getCapability?: (toolId: WorkspaceToolId) => ToolCapability;
	/** Composite color under a document point, for Option-click sampling. */
	sampleComposite?: (point: ToolPoint) => {r: number; g: number; b: number; a: number} | null;
};

export interface ToolSession {
	readonly toolId: WorkspaceToolId;
	readonly status: ToolSessionStatus;
	pointerDown(event: ToolPointerEvent): void | Promise<void>;
	pointerMove(event: ToolPointerEvent): void | Promise<void>;
	pointerUp(event: ToolPointerEvent): void | Promise<void>;
	pointerCancel(reason: ToolCancelReason): void;
	keyDown?(event: ToolKeyEvent): boolean;
	keyUp?(event: ToolKeyEvent): boolean;
	updateContext?(context: ToolSessionContext): void;
	getOverlayState?(): ToolOverlayState | null;
	sync?(): void;
	dispose(): void;
}

export type ToolDefinition = {
	id: WorkspaceToolId;
	label: string;
	shortcut?: string;
	statusHint: string;
	requirements: ToolRequirement[];
	cursor: ToolCursor;
	createSession: (context: ToolSessionContext) => ToolSession;
};

export const isImplementedTool = (id: WorkspaceToolId) => ['move', 'marquee-rectangle', 'marquee-ellipse', 'lasso', 'polygon-lasso', 'brush', 'healing', 'clone-stamp', 'hand', 'zoom'].includes(id);
