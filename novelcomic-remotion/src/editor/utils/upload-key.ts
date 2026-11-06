const USER_ID_SEARCH_PARAM_KEYS = ['userId', 'user_id', 'uid', 'user'] as const;
const USER_ID_PATHNAME_PATTERN = /^user_[A-Za-z0-9._-]+$/;

const sanitizePathSegment = (value: string, fallback: string) => {
	const normalized = value
		.normalize('NFKD')
		.split('')
		.filter((char) => char.charCodeAt(0) <= 0x7f)
		.join('')
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');

	return normalized.length > 0 ? normalized : fallback;
};

export const sanitizeUserId = (value: string | null | undefined) => {
	if (!value) {
		return 'default';
	}

	return sanitizePathSegment(value, 'default');
};

export const sanitizeFilename = (value: string | null | undefined) => {
	if (!value) {
		return 'file';
	}

	const fileName = value.split('/').pop()?.split('\\').pop() ?? value;
	return sanitizePathSegment(fileName, 'file');
};

export const getUtcDatePath = (date: Date = new Date()) => {
	return date.toISOString().slice(0, 10).replace(/-/g, '');
};

const createUploadId = () => {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
		return crypto.randomUUID();
	}

	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export const getUserIdFromUrl = (url: string | URL) => {
	const parsedUrl = typeof url === 'string' ? new URL(url) : url;

	for (const key of USER_ID_SEARCH_PARAM_KEYS) {
		const value = parsedUrl.searchParams.get(key);
		if (value) {
			return sanitizeUserId(value);
		}
	}

	const pathUserId = parsedUrl.pathname
		.split('/')
		.map((segment) => segment.trim())
		.find((segment) => USER_ID_PATHNAME_PATTERN.test(segment));

	return sanitizeUserId(pathUserId);
};

export const getCurrentUserIdFromUrl = () => {
	if (typeof window === 'undefined') {
		return 'default';
	}

	return getUserIdFromUrl(window.location.href);
};

export const buildUploadFileKey = ({
	filename,
	userId,
	date,
}: {
	filename: string | null | undefined;
	userId: string | null | undefined;
	date?: Date;
}) => {
	return `remotion/${getUtcDatePath(date)}/${sanitizeUserId(userId)}/${createUploadId()}-${sanitizeFilename(filename)}`;
};
