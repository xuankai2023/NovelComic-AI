import {
	applyMaskStroke,
	createMaskSurface,
	createMaskTileDiff,
	invertMaskSurface,
	refineMaskSurface,
	type MaskBrush,
	type MaskPoint,
	type MaskSurface,
	type MaskTileDiff,
} from './mask-pixel-core';
type Result = {surface: MaskSurface; diff: MaskTileDiff | null};
export class MaskPixelClient {
	private worker: Worker | null = null;
	private pending = new Map<
		string,
		{resolve: (value: Result) => void; reject: (error: Error) => void}
	>();
	constructor() {
		if (typeof Worker !== 'undefined') {
			this.worker = new Worker(
				new URL('./mask-pixel-worker.ts', import.meta.url),
				{type: 'module'},
			);
			this.worker.onmessage = (
				event: MessageEvent<{
					id: string;
					surface?: MaskSurface;
					diff?: MaskTileDiff | null;
					error?: string;
				}>,
			) => {
				const pending = this.pending.get(event.data.id);
				if (!pending) return;
				this.pending.delete(event.data.id);
				if (event.data.error) pending.reject(new Error(event.data.error));
				else
					pending.resolve({
						surface: event.data.surface!,
						diff: event.data.diff ?? null,
					});
			};
		}
	}
	private run(
		payload: Record<string, unknown>,
		fallback: () => Result,
	): Promise<Result> {
		if (!this.worker) return Promise.resolve(fallback());
		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			this.pending.set(id, {resolve, reject});
			this.worker!.postMessage({id, ...payload});
		});
	}
	create(width: number, height: number, value = 255) {
		return this.run({operation: 'create', width, height, value}, () => ({
			surface: createMaskSurface(width, height, value),
			diff: null,
		}));
	}
	stroke(
		surface: MaskSurface,
		points: MaskPoint[],
		brush: MaskBrush,
		mode: 'paint' | 'erase' | 'blur',
	) {
		return this.run({operation: 'stroke', surface, points, brush, mode}, () => {
			const next = applyMaskStroke(surface, points, brush, mode);
			return {surface: next, diff: createMaskTileDiff(surface, next)};
		});
	}
	refine(
		surface: MaskSurface,
		settings: Parameters<typeof refineMaskSurface>[1],
	) {
		return this.run({operation: 'refine', surface, settings}, () => {
			const next = refineMaskSurface(surface, settings);
			return {surface: next, diff: createMaskTileDiff(surface, next)};
		});
	}
	invert(surface: MaskSurface) {
		return this.run({operation: 'invert', surface}, () => {
			const next = invertMaskSurface(surface);
			return {surface: next, diff: createMaskTileDiff(surface, next)};
		});
	}
	dispose() {
		this.worker?.terminate();
		this.worker = null;
		this.pending.clear();
	}
}
