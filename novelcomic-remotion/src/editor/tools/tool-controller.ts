import type {ToolCancelReason, ToolDefinition, ToolKeyEvent, ToolOverlayState, ToolPointerEvent, ToolSession, ToolSessionContext, WorkspaceToolId} from './types';
import {getToolDefinition} from './tool-registry';

export class ToolController {
	private definition = getToolDefinition('move');
	private session: ToolSession;
	private pointerId: number | null = null;
	private context: ToolSessionContext;
	/** The tool parked while Space or the middle button pans, so an open lasso is not thrown away. */
	private parked: {definition: ToolDefinition; session: ToolSession} | null = null;

	constructor(context: ToolSessionContext) {
		this.context = context;
		this.session = this.definition.createSession(context);
	}

	get toolId() {
		return this.definition.id;
	}

	get cursor() {
		return this.definition.cursor;
	}

	getOverlayState(): ToolOverlayState | null {
		return this.session.getOverlayState?.() ?? null;
	}

	updateContext(context: ToolSessionContext) {
		this.context = context;
		this.session.updateContext?.(context);
		this.session.sync?.();
		this.parked?.session.updateContext?.(context);
		this.parked?.session.sync?.();
	}

	activate(toolId: WorkspaceToolId) {
		if (this.parked) {
			this.parked.session.pointerCancel('tool-switch');
			this.parked.session.dispose();
			this.parked = null;
		}
		if (toolId === this.definition.id) return;
		this.cancel('tool-switch');
		this.session.dispose();
		this.definition = getToolDefinition(toolId);
		this.session = this.definition.createSession(this.context);
		this.pointerId = null;
	}

	/**
	 * Swaps in `toolId` without disposing the current session. Used for Space and the
	 * middle button, which pan in Compositor without leaving the Lasso's corners behind.
	 * Returns false while a button is already down, so a stroke in progress is left alone.
	 */
	suspendFor(toolId: WorkspaceToolId) {
		if (this.parked || this.pointerId !== null) return false;
		const definition = getToolDefinition(toolId);
		this.parked = {definition: this.definition, session: this.session};
		this.definition = definition;
		this.session = definition.createSession(this.context);
		this.pointerId = null;
		return true;
	}

	resume() {
		if (!this.parked) return false;
		this.cancel('tool-switch');
		this.session.dispose();
		this.definition = this.parked.definition;
		this.session = this.parked.session;
		this.parked = null;
		this.pointerId = null;
		this.session.updateContext?.(this.context);
		this.session.sync?.();
		return true;
	}

	pointerDown(event: ToolPointerEvent) {
		if (this.pointerId !== null || (this.context.getCapability && !this.context.getCapability(this.definition.id).enabled)) return false;
		this.pointerId = event.pointerId;
		void this.session.pointerDown(event);
		return true;
	}

	pointerMove(event: ToolPointerEvent) {
		if (this.pointerId === null || this.pointerId === event.pointerId) void this.session.pointerMove(event);
	}

	pointerUp(event: ToolPointerEvent) {
		if (this.pointerId === event.pointerId) {
			void this.session.pointerUp(event);
			this.pointerId = null;
		}
	}

	pointerCancel(reason: ToolCancelReason) {
		this.cancel(reason);
	}

	keyDown(event: ToolKeyEvent) {
		if (event.key === 'Escape') {
			this.cancel('escape');
			this.parked?.session.pointerCancel('escape');
			return true;
		}
		return this.session.keyDown?.(event) ?? false;
	}

	keyUp(event: ToolKeyEvent) {
		return this.session.keyUp?.(event) ?? false;
	}

	cancel(reason: ToolCancelReason) {
		if (this.pointerId !== null || this.session.status === 'active') this.session.pointerCancel(reason);
		this.pointerId = null;
	}

	dispose() {
		this.cancel('unmount');
		this.session.dispose();
		if (this.parked) {
			this.parked.session.pointerCancel('unmount');
			this.parked.session.dispose();
			this.parked = null;
		}
	}
}
