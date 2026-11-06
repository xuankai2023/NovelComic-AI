import type {GetProgressPayload, GetProgressResponse} from './types';

export const RENDER_POLL_INTERVAL_MS = 2000;
export const HIDDEN_RENDER_POLL_INTERVAL_MS = 5000;
export const RENDER_POLL_BACKOFF_MS = [2000, 4000, 8000] as const;

export type RenderPollingController = {
	start: () => void;
	stop: () => void;
	signal: AbortSignal;
};

export type RenderPollingControllerOptions = {
	bucketName: string;
	renderId: string;
	startedAt?: number;
	fetchProgress?: (
		payload: GetProgressPayload,
		signal: AbortSignal,
	) => Promise<GetProgressResponse>;
	onProgress: (response: GetProgressResponse) => void | Promise<void>;
	onNetworkFailure?: (error: unknown, failures: number) => void | Promise<void>;
	intervalMs?: number;
	hiddenIntervalMs?: number;
	maxNetworkFailures?: number;
};

const defaultFetchProgress = async (
	payload: GetProgressPayload,
	signal: AbortSignal,
): Promise<GetProgressResponse> => {
	const response = await fetch('/api/progress', {
		method: 'POST',
		headers: {'content-type': 'application/json'},
		body: JSON.stringify(payload),
		signal,
	});
	let json: unknown;
	try {
		json = await response.json();
	} catch {
		throw new Error(
			`Progress request returned invalid JSON (${response.status}).`,
		);
	}
	if (!response.ok && (!json || typeof json !== 'object')) {
		throw new Error(`Progress request failed with status ${response.status}.`);
	}
	return json as GetProgressResponse;
};

const isHidden = () =>
	typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * Polling is an explicit timer/request loop so every request and timer can be
 * aborted. A recursive Promise chain would keep running after a cancel click.
 */
export const createRenderPollingController = (
	options: RenderPollingControllerOptions,
): RenderPollingController => {
	const controller = new AbortController();
	const fetchProgress = options.fetchProgress ?? defaultFetchProgress;
	let running = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const stop = () => {
		running = false;
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		if (!controller.signal.aborted) controller.abort();
	};

	const run = async () => {
		let networkFailures = 0;
		while (running && !controller.signal.aborted) {
			try {
				const response = await fetchProgress(
					{
						bucketName: options.bucketName,
						renderId: options.renderId,
						startedAt: options.startedAt,
					},
					controller.signal,
				);
				networkFailures = 0;
				await options.onProgress(response);
				if (
					response.type === 'done' ||
					response.type === 'error' ||
					response.type === 'canceled'
				) {
					stop();
					return;
				}
			} catch (error) {
				if (controller.signal.aborted) return;
				networkFailures += 1;
				await options.onNetworkFailure?.(error, networkFailures);
				if (networkFailures >= (options.maxNetworkFailures ?? 3)) {
					stop();
					return;
				}
			}

			if (!running || controller.signal.aborted) return;
			const backoff =
				networkFailures > 0
					? RENDER_POLL_BACKOFF_MS[Math.min(networkFailures - 1, 2)]
					: isHidden()
						? (options.hiddenIntervalMs ?? HIDDEN_RENDER_POLL_INTERVAL_MS)
						: (options.intervalMs ?? RENDER_POLL_INTERVAL_MS);
			try {
				await new Promise<void>((resolve, reject) => {
					timer = setTimeout(() => {
						timer = null;
						resolve();
					}, backoff);
					const onAbort = () => {
						if (timer !== null) {
							clearTimeout(timer);
							timer = null;
						}
						reject(new DOMException('Polling aborted', 'AbortError'));
					};
					controller.signal.addEventListener('abort', onAbort, {once: true});
				});
			} catch {
				return;
			}
		}
	};

	return {
		start: () => {
			if (running || controller.signal.aborted) return;
			running = true;
			void run();
		},
		stop,
		signal: controller.signal,
	};
};

export const createPollingController = createRenderPollingController;
