import {COMIC_ERROR_CODES, ComicEditorError} from '../comic/errors';

export type RemoteUrlPolicy = {
	allowedHosts: readonly string[];
	maxRedirects?: number;
};

const DEFAULT_MAX_REDIRECTS = 5;

const remoteError = (message: string): ComicEditorError => {
	return new ComicEditorError({
		code: COMIC_ERROR_CODES.INVALID_REMOTE_URL,
		message,
		retryable: false,
		status: 422,
	});
};

const bareHost = (hostname: string): string => {
	const host = hostname.toLowerCase().replace(/\.$/, '');
	if (host.startsWith('[') && host.endsWith(']')) {
		return host.slice(1, -1);
	}

	return host.split('%')[0] ?? host;
};

const isLocalHostname = (host: string): boolean => {
	return (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host.endsWith('.local') ||
		host === 'metadata.google.internal'
	);
};

const parseDottedIpv4 = (host: string): string | null => {
	const parts = host.split('.');
	if (parts.length !== 4) {
		return null;
	}

	const numbers = parts.map((part) => {
		if (!/^\d+$/.test(part)) {
			return Number.NaN;
		}

		return Number(part);
	});
	if (
		numbers.some((value) => {
			return !Number.isInteger(value) || value < 0 || value > 255;
		})
	) {
		return null;
	}

	return numbers.join('.');
};

const ipv4FromInteger = (host: string): string | null => {
	if (!/^\d+$/.test(host)) {
		return null;
	}

	const value = Number(host);
	if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
		return null;
	}

	return [
		(value >>> 24) & 255,
		(value >>> 16) & 255,
		(value >>> 8) & 255,
		value & 255,
	].join('.');
};

const ipv4FromMapped = (address: string): string | null => {
	const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
	if (dotted?.[1]) {
		return parseDottedIpv4(dotted[1]);
	}

	const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
	if (hexadecimal?.[1] && hexadecimal[2]) {
		const high = Number.parseInt(hexadecimal[1], 16);
		const low = Number.parseInt(hexadecimal[2], 16);
		return [(high >>> 8) & 255, high & 255, (low >>> 8) & 255, low & 255].join(
			'.',
		);
	}

	return null;
};

const ipv4ToNumber = (address: string): number | null => {
	const parsed = parseDottedIpv4(address);
	if (!parsed) {
		return null;
	}

	return parsed
		.split('.')
		.reduce((value, part) => value * 256 + Number(part), 0);
};

const isInIpv4Range = (
	address: string,
	start: number,
	end: number,
): boolean => {
	const value = ipv4ToNumber(address);
	return value !== null && value >= start && value <= end;
};

const isBlockedIpv4 = (address: string): boolean => {
	return (
		isInIpv4Range(address, 0x00000000, 0x00ffffff) ||
		isInIpv4Range(address, 0x0a000000, 0x0affffff) ||
		isInIpv4Range(address, 0x64400000, 0x647fffff) ||
		isInIpv4Range(address, 0x7f000000, 0x7fffffff) ||
		isInIpv4Range(address, 0xa9fe0000, 0xa9feffff) ||
		isInIpv4Range(address, 0xac100000, 0xac1fffff) ||
		isInIpv4Range(address, 0xc0a80000, 0xc0a8ffff) ||
		isInIpv4Range(address, 0xe0000000, 0xefffffff)
	);
};

const isIpv6 = (address: string): boolean => address.includes(':');

const isBlockedIpv6 = (address: string): boolean => {
	const normalized = address.toLowerCase();
	return (
		normalized === '::' ||
		normalized === '::1' ||
		normalized.startsWith('fc') ||
		normalized.startsWith('fd') ||
		/^fe[89ab]/.test(normalized) ||
		normalized.startsWith('ff')
	);
};

const isBlockedIp = (address: string): boolean => {
	const mapped = ipv4FromMapped(address);
	if (mapped) {
		return isBlockedIpv4(mapped);
	}

	const dotted = parseDottedIpv4(address);
	if (dotted) {
		return isBlockedIpv4(dotted);
	}

	return isIpv6(address) && isBlockedIpv6(address);
};

const hostMatches = (
	host: string,
	allowedHosts: readonly string[],
): boolean => {
	return allowedHosts.some((entry) => {
		const allowed = bareHost(entry);
		return host === allowed || host.endsWith(`.${allowed}`);
	});
};

const assertAllowedRemoteUrl = (
	value: string,
	allowedHosts: readonly string[],
): string => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw remoteError('Remote URL is invalid');
	}

	if (url.protocol !== 'https:') {
		throw remoteError('HTTPS is required');
	}

	if (url.username || url.password) {
		throw remoteError('Remote URL credentials are not allowed');
	}

	const host = bareHost(url.hostname);
	if (isLocalHostname(host)) {
		throw remoteError('Private or local addresses are not allowed');
	}

	const integerIp = ipv4FromInteger(host);
	if (
		isBlockedIp(host) ||
		(integerIp !== null && isBlockedIp(integerIp)) ||
		integerIp !== null
	) {
		throw remoteError('Private or local addresses are not allowed');
	}

	const normalizedIp = parseDottedIpv4(host);
	if (
		!hostMatches(host, allowedHosts) &&
		(normalizedIp === null || !hostMatches(normalizedIp, allowedHosts))
	) {
		throw remoteError('Host is not allowlisted');
	}

	return url.href;
};

export const resolveAllowedHosts = (
	override?: readonly string[],
): readonly string[] => {
	if (override) {
		return override;
	}

	const hosts = new Set<string>();
	const configured = process.env.COMIC_ALLOWED_REMOTE_HOSTS ?? '';
	for (const entry of configured.split(/[,\s]+/)) {
		const host = entry.trim();
		if (host) {
			hosts.add(host);
		}
	}

	const cosDomain = process.env.COS_CDN_DOMAIN?.trim();
	if (cosDomain) {
		try {
			hosts.add(new URL(cosDomain).hostname);
		} catch {
			hosts.add(cosDomain);
		}
	}

	return [...hosts];
};

export const findUnsafeRemoteUrlReason = (value: string): string | null => {
	try {
		assertAllowedRemoteUrl(value, ['*']);
		return null;
	} catch (error) {
		if (!(error instanceof ComicEditorError)) {
			return 'Remote URL is invalid';
		}

		if (error.message === 'Host is not allowlisted') {
			return null;
		}

		return error.message;
	}
};

export const validateRemoteUrl = (
	url: string,
	policy: RemoteUrlPolicy,
	redirects: readonly string[] = [],
): string => {
	const maxRedirects = policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	if (redirects.length > maxRedirects) {
		throw remoteError('Too many redirects');
	}

	let current = '';
	for (const hop of [url, ...redirects]) {
		current = assertAllowedRemoteUrl(hop, policy.allowedHosts);
	}

	return current;
};
