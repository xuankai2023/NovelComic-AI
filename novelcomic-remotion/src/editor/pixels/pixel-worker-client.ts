import {runPixelOperation, type PixelWorkerOperation, type PixelWorkerResult} from './pixel-worker-core';

export class PixelWorkerClient {
	private worker: Worker | null = null;
	private pending = new Map<string, {resolve: (value: PixelWorkerResult) => void; reject: (error: Error) => void}>();
	constructor() {
		if (typeof Worker === 'undefined') return;
		this.worker = new Worker(new URL('./pixel-worker.ts', import.meta.url), {type: 'module'});
		this.worker.onmessage = (event: MessageEvent<{id: string; result?: PixelWorkerResult; error?: string}>) => { const pending = this.pending.get(event.data.id); if (!pending) return; this.pending.delete(event.data.id); if (event.data.error) pending.reject(new Error(event.data.error)); else pending.resolve(event.data.result!); };
	}
	run(operation: PixelWorkerOperation): Promise<PixelWorkerResult> {
		if (!this.worker) return Promise.resolve(runPixelOperation(operation));
		const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
		return new Promise((resolve, reject) => { this.pending.set(id, {resolve, reject}); this.worker!.postMessage({id, operation}); });
	}
	dispose() { this.worker?.terminate(); this.worker = null; for (const pending of this.pending.values()) pending.reject(new Error('Pixel worker disposed')); this.pending.clear(); }
}
