import type {PixelBuffer} from './pixel-tools';

/** A non-React transaction for tool preview/cancel/apply. The source is kept
 * immutable; callers commit the returned buffer through a document command. */
export class PixelEditSession {
	private readonly original: PixelBuffer;
	private previewBuffer: PixelBuffer;
	private closed = false;
	constructor(source: PixelBuffer) { this.original = {width: source.width, height: source.height, data: new Uint8ClampedArray(source.data)}; this.previewBuffer = {width: source.width, height: source.height, data: new Uint8ClampedArray(source.data)}; }
	preview(next: PixelBuffer): PixelBuffer { if (this.closed) throw new Error('Pixel edit session is closed'); if (next.width !== this.original.width || next.height !== this.original.height) throw new Error('Pixel dimensions must match'); this.previewBuffer = {width: next.width, height: next.height, data: new Uint8ClampedArray(next.data)}; return this.current; }
	get current(): PixelBuffer { return {width: this.previewBuffer.width, height: this.previewBuffer.height, data: new Uint8ClampedArray(this.previewBuffer.data)}; }
	apply(): PixelBuffer { if (this.closed) throw new Error('Pixel edit session is closed'); this.closed = true; return this.current; }
	cancel(): PixelBuffer { if (this.closed) throw new Error('Pixel edit session is closed'); this.closed = true; return {width: this.original.width, height: this.original.height, data: new Uint8ClampedArray(this.original.data)}; }
}
