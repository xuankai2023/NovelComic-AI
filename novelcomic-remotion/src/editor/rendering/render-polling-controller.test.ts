import {afterEach, describe, expect, it, vi} from 'vitest';
import {createRenderPollingController} from './render-polling-controller';

afterEach(() => {
	vi.useRealTimers();
});

describe('render polling controller', () => {
	it('queries immediately, then stops on a terminal response', async () => {
		vi.useFakeTimers();
		const responses = [
			{type: 'in-progress' as const, overallProgress: 0.2},
			{
				type: 'done' as const,
				outputFile: 'https://cdn.example.com/video.mp4',
				outputName: 'video.mp4',
				outputSizeInBytes: 4,
			},
		];
		const fetchProgress = vi.fn(async () => responses.shift()!);
		const onProgress = vi.fn();
		const controller = createRenderPollingController({
			bucketName: 'local',
			renderId: 'render-1',
			fetchProgress,
			onProgress,
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchProgress).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2000);
		expect(fetchProgress).toHaveBeenCalledTimes(2);
		expect(onProgress).toHaveBeenCalledTimes(2);
		expect(controller.signal.aborted).toBe(true);
	});

	it('backs off network failures and reports the third failure', async () => {
		vi.useFakeTimers();
		const onNetworkFailure = vi.fn();
		const fetchProgress = vi.fn(async () => {
			throw new Error('offline');
		});
		const controller = createRenderPollingController({
			bucketName: 'lambda-bucket',
			renderId: 'render-2',
			fetchProgress,
			onProgress: vi.fn(),
			onNetworkFailure,
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(2000);
		await vi.advanceTimersByTimeAsync(4000);
		await vi.advanceTimersByTimeAsync(8000);
		expect(fetchProgress).toHaveBeenCalledTimes(3);
		expect(onNetworkFailure).toHaveBeenLastCalledWith(expect.any(Error), 3);
		expect(controller.signal.aborted).toBe(true);
	});

	it('aborts an in-flight request and timer', async () => {
		vi.useFakeTimers();
		let rejectRequest: ((reason?: unknown) => void) | undefined;
		const fetchProgress = vi.fn(
			(_payload: unknown, signal: AbortSignal) =>
				new Promise<never>((_, reject) => {
					rejectRequest = reject;
					signal.addEventListener('abort', () => reject(new Error('aborted')));
				}),
		);
		const controller = createRenderPollingController({
			bucketName: 'local',
			renderId: 'render-3',
			fetchProgress,
			onProgress: vi.fn(),
		});

		controller.start();
		await vi.advanceTimersByTimeAsync(0);
		controller.stop();
		rejectRequest?.(new Error('aborted'));
		expect(controller.signal.aborted).toBe(true);
	});
});
