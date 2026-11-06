export type ComposeErrorResponse = {
	type?: 'error';
	message?: string;
	code?: string;
	retryable?: boolean;
};

export const postCompose = async <T>(
	path: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<T> => {
	const response = await fetch(path, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
		signal,
	});

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error(`Request failed with HTTP ${response.status}`);
	}

	if (
		!response.ok ||
		(typeof payload === 'object' &&
			payload !== null &&
			'type' in payload &&
			(payload as ComposeErrorResponse).type === 'error')
	) {
		const error = payload as ComposeErrorResponse;
		throw new Error(
			error.message?.trim() || `Request failed with HTTP ${response.status}`,
		);
	}

	return payload as T;
};
