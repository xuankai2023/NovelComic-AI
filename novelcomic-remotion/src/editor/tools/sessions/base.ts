import type {
	ToolCancelReason,
	ToolOverlayState,
	ToolPointerEvent,
	ToolSession,
	ToolSessionContext,
	ToolSessionStatus,
	WorkspaceToolId,
} from '../types';

export abstract class BaseToolSession implements ToolSession {
	protected _status: ToolSessionStatus = 'idle';
	protected overlay: ToolOverlayState | null = null;

	constructor(
		readonly toolId: WorkspaceToolId,
		protected context: ToolSessionContext,
	) {}

	get status() {
		return this._status;
	}

	updateContext(context: ToolSessionContext) {
		this.context = context;
	}

	pointerDown(_event: ToolPointerEvent) {
		void _event;
		this._status = 'active';
	}

	pointerMove(_event: ToolPointerEvent) {
		void _event;
	}

	pointerUp(_event: ToolPointerEvent) {
		void _event;
		this._status = 'committed';
	}

	pointerCancel(_reason: ToolCancelReason) {
		void _reason;
		if (this._status !== 'disposed') this._status = 'cancelled';
		this.overlay = null;
	}

	getOverlayState() {
		return this.overlay;
	}

	dispose() {
		this.overlay = null;
		this._status = 'disposed';
	}
}
