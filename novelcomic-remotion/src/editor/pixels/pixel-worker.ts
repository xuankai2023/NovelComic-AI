import {runPixelOperation, type PixelWorkerOperation} from './pixel-worker-core';

self.onmessage = (event: MessageEvent<{id: string; operation: PixelWorkerOperation}>) => {
	try { self.postMessage({id: event.data.id, result: runPixelOperation(event.data.operation)}); }
	catch (error) { self.postMessage({id: event.data.id, error: error instanceof Error ? error.message : 'Pixel operation failed'}); }
};
