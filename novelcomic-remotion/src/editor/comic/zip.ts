const textEncoder = new TextEncoder();

export type ZipEntry = {
	path: string;
	body: Buffer | string;
};

export type StoredZipEntry = {
	path: string;
	body: Buffer;
};

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
	let value = index;
	for (let bit = 0; bit < 8; bit++) {
		value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	}
	crcTable[index] = value >>> 0;
}

const crc32 = (body: Buffer): number => {
	let crc = 0xffffffff;
	for (const byte of body) {
		crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
	}

	return (crc ^ 0xffffffff) >>> 0;
};

const normalizeZipPath = (path: string): string => {
	const clean = path
		.replace(/\\/g, '/')
		.split('/')
		.filter((part) => part && part !== '.' && part !== '..')
		.join('/');
	if (!clean) {
		throw new Error('zip entry path cannot be empty');
	}

	return clean;
};

const uint16 = (value: number): Buffer => {
	const buffer = Buffer.allocUnsafe(2);
	buffer.writeUInt16LE(value);
	return buffer;
};

const uint32 = (value: number): Buffer => {
	const buffer = Buffer.allocUnsafe(4);
	buffer.writeUInt32LE(value >>> 0);
	return buffer;
};

const dosDateTime = (date: Date): {date: number; time: number} => {
	const year = Math.max(1980, date.getFullYear());
	return {
		time:
			(date.getHours() << 11) |
			(date.getMinutes() << 5) |
			Math.floor(date.getSeconds() / 2),
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
};

const toBody = (body: Buffer | string): Buffer => {
	return Buffer.isBuffer(body) ? body : Buffer.from(textEncoder.encode(body));
};

export const createStoredZip = (
	entries: readonly ZipEntry[],
	now = new Date(),
): Buffer => {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;
	const stamp = dosDateTime(now);

	for (const entry of entries) {
		const name = Buffer.from(normalizeZipPath(entry.path));
		const body = toBody(entry.body);
		const crc = crc32(body);
		const localHeader = Buffer.concat([
			uint32(0x04034b50),
			uint16(20),
			uint16(0),
			uint16(0),
			uint16(stamp.time),
			uint16(stamp.date),
			uint32(crc),
			uint32(body.length),
			uint32(body.length),
			uint16(name.length),
			uint16(0),
			name,
		]);
		localParts.push(localHeader, body);

		const centralHeader = Buffer.concat([
			uint32(0x02014b50),
			uint16(20),
			uint16(20),
			uint16(0),
			uint16(0),
			uint16(stamp.time),
			uint16(stamp.date),
			uint32(crc),
			uint32(body.length),
			uint32(body.length),
			uint16(name.length),
			uint16(0),
			uint16(0),
			uint16(0),
			uint16(0),
			uint32(0),
			uint32(offset),
			name,
		]);
		centralParts.push(centralHeader);
		offset += localHeader.length + body.length;
	}

	const centralDirectory = Buffer.concat(centralParts);
	const end = Buffer.concat([
		uint32(0x06054b50),
		uint16(0),
		uint16(0),
		uint16(entries.length),
		uint16(entries.length),
		uint32(centralDirectory.length),
		uint32(offset),
		uint16(0),
	]);

	return Buffer.concat([...localParts, centralDirectory, end]);
};

/**
 * Read archives produced by createStoredZip. Delivery packages intentionally
 * use the stored ZIP method, so verification does not need a decompression
 * dependency or a second archive implementation.
 */
export const readStoredZip = (archive: Buffer): StoredZipEntry[] => {
	const entries: StoredZipEntry[] = [];
	let offset = 0;

	while (offset + 4 <= archive.length) {
		const signature = archive.readUInt32LE(offset);
		if (signature === 0x02014b50 || signature === 0x06054b50) {
			break;
		}
		if (signature !== 0x04034b50) {
			throw new Error(`Unsupported ZIP local header at offset ${offset}`);
		}

		if (offset + 30 > archive.length) {
			throw new Error('Truncated ZIP local header');
		}

		const compressionMethod = archive.readUInt16LE(offset + 8);
		const compressedSize = archive.readUInt32LE(offset + 18);
		const filenameLength = archive.readUInt16LE(offset + 26);
		const extraLength = archive.readUInt16LE(offset + 28);
		const filenameStart = offset + 30;
		const bodyStart = filenameStart + filenameLength + extraLength;
		const bodyEnd = bodyStart + compressedSize;

		if (compressionMethod !== 0) {
			throw new Error('Only stored ZIP entries are supported');
		}
		if (bodyEnd > archive.length) {
			throw new Error('Truncated ZIP entry');
		}

		const path = archive
			.subarray(filenameStart, filenameStart + filenameLength)
			.toString('utf8');
		entries.push({
			path,
			body: Buffer.from(archive.subarray(bodyStart, bodyEnd)),
		});
		offset = bodyEnd;
	}

	if (entries.length === 0) {
		throw new Error('ZIP archive contains no stored entries');
	}

	return entries;
};
