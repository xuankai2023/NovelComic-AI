/// <reference lib="webworker" />
import {
	applyMaskStroke,
	createMaskSurface,
	createMaskTileDiff,
	invertMaskSurface,
	refineMaskSurface,
	type MaskSurface,
} from './mask-pixel-core';
type Request = {
	id: string;
	operation: 'create' | 'stroke' | 'refine' | 'invert';
	surface?: MaskSurface;
	width?: number;
	height?: number;
	value?: number;
	points?: Parameters<typeof applyMaskStroke>[1];
	brush?: Parameters<typeof applyMaskStroke>[2];
	mode?: Parameters<typeof applyMaskStroke>[3];
	settings?: Parameters<typeof refineMaskSurface>[1];
};
self.onmessage = (event: MessageEvent<Request>) => {
	const request = event.data;
	try {
		const before = request.surface;
		const surface =
			request.operation === 'create'
				? createMaskSurface(request.width!, request.height!, request.value)
				: request.operation === 'stroke'
					? applyMaskStroke(
							before!,
							request.points!,
							request.brush!,
							request.mode!,
						)
					: request.operation === 'refine'
						? refineMaskSurface(before!, request.settings!)
						: invertMaskSurface(before!);
		const diff = before ? createMaskTileDiff(before, surface) : null;
		self.postMessage({id: request.id, surface, diff}, [
			surface.alpha.buffer,
			...(diff?.tiles.flatMap((tile) => [
				tile.before.buffer,
				tile.after.buffer,
			]) ?? []),
		]);
	} catch (error) {
		self.postMessage({
			id: request.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};
export {};
