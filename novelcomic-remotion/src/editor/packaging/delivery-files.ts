import {createHash} from 'node:crypto';

export type DeliveryFileInput = {
	path: string;
	category: string;
	body: Buffer | string;
	required?: boolean;
};

export type DeliveryFile = {
	path: string;
	category: string;
	required: boolean;
	sizeBytes: number;
	checksum: string;
	body: Buffer;
};

const normalizePath = (path: string): string => {
	const normalizedInput = path.replace(/\\/g, '/');
	if (!normalizedInput || normalizedInput.startsWith('/')) {
		throw new Error(`Invalid delivery path: ${path}`);
	}

	const parts: string[] = [];
	for (const part of normalizedInput.split('/')) {
		if (!part || part === '.') {
			continue;
		}
		if (part === '..') {
			if (parts.length === 0) {
				throw new Error(`Invalid delivery path: ${path}`);
			}
			parts.pop();
			continue;
		}
		parts.push(part);
	}

	if (parts.length === 0) {
		throw new Error(`Invalid delivery path: ${path}`);
	}
	return parts.join('/');
};

export const collectDeliveryFiles = (
	files: readonly DeliveryFileInput[],
): DeliveryFile[] => {
	const seen = new Set<string>();
	return files.map((file) => {
		const path = normalizePath(file.path);
		if (seen.has(path)) {
			throw new Error(`Duplicate delivery path: ${path}`);
		}
		seen.add(path);
		const body = Buffer.isBuffer(file.body)
			? Buffer.from(file.body)
			: Buffer.from(file.body, 'utf8');
		return {
			path,
			category: file.category,
			required: file.required ?? true,
			sizeBytes: body.length,
			checksum: createHash('sha256').update(body).digest('hex'),
			body,
		};
	});
};

export const verifyDeliveryFiles = (
	files: readonly DeliveryFile[],
): void => {
	const seen = new Set<string>();
	for (const file of files) {
		if (seen.has(file.path)) {
			throw new Error(`Duplicate delivery path: ${file.path}`);
		}
		seen.add(file.path);
		if (file.sizeBytes !== file.body.length) {
			throw new Error(`Delivery size mismatch: ${file.path}`);
		}
		const checksum = createHash('sha256').update(file.body).digest('hex');
		if (checksum !== file.checksum) {
			throw new Error(`Delivery checksum mismatch: ${file.path}`);
		}
	}
};
