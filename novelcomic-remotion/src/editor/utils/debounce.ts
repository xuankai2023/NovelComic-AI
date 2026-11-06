export function debounce<TArgs extends unknown[]>(
	fn: (...args: TArgs) => void,
	delay: number,
	{leading = false}: {leading?: boolean} = {},
): (...args: TArgs) => void {
	let timeoutId: NodeJS.Timeout | undefined;
	let isLeadingInvoked = false;

	return (...args: TArgs) => {
		clearTimeout(timeoutId);

		if (leading && !isLeadingInvoked) {
			fn(...args);
			isLeadingInvoked = true;
		}

		timeoutId = setTimeout(() => {
			if (!leading) fn(...args);
			isLeadingInvoked = false;
		}, delay);
	};
}
