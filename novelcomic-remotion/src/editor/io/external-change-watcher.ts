export type ExternalChange = {revision: number; contentHash: string};
export type ExternalChangeWatcherOptions = {debounceMs?: number; read: () => Promise<ExternalChange | null>; onChange: (change: ExternalChange) => void; onError?: (error: unknown) => void};

export class ExternalChangeWatcher {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private last: ExternalChange | null = null;
	constructor(private readonly options: ExternalChangeWatcherOptions) {}
	async start(): Promise<void> { this.running = true; await this.check(); }
	stop(): void { this.running = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
	schedule(): void { if (!this.running || this.timer) return; this.timer = setTimeout(() => { this.timer = undefined; void this.check(); }, this.options.debounceMs ?? 300); }
	async check(): Promise<void> { if (!this.running) return; try { const next = await this.options.read(); if (next && (!this.last || next.revision !== this.last.revision || next.contentHash !== this.last.contentHash)) { this.last = next; this.options.onChange(next); } } catch (error) { this.options.onError?.(error); } }
}
