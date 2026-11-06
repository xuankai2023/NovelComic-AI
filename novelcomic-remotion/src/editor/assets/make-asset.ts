import {getGifDurationInSeconds} from '@remotion/gif';
import {ALL_FORMATS, BlobSource, Input} from 'mediabunny';
import {cacheAssetLocally} from '../caching/indexeddb';
import {setLocalUrl} from '../caching/load-to-blob-url';
import {detectFileType} from '../utils/detect-file-type';
import {generateRandomId} from '../utils/generate-random-id';
import {getSvgDimensions} from '../utils/get-svg-dimensions';
import {EditorStarterAsset} from './assets';

export const makeAsset = async ({
	file,
	filename,
	remoteUrl,
	remoteFileKey,
}: {
	file: Blob;
	filename: string;
	remoteUrl: string | null;
	remoteFileKey: string | null;
}): Promise<EditorStarterAsset> => {
	const assetId = generateRandomId();
	const url = URL.createObjectURL(file);
	setLocalUrl(assetId, url);
	await cacheAssetLocally({assetId, value: file});

	const fileType = await detectFileType(file);

	if (fileType.category === 'image') {
		if (!fileType.dimensions) {
			throw new Error('Could not get dimensions for image');
		}

		if (fileType.type === 'gif') {
			const durationInSeconds = await getGifDurationInSeconds(url);
			return {
				id: assetId,
				type: 'gif',
				durationInSeconds,
				filename,
				remoteUrl,
				remoteFileKey,
				size: file.size,
				mimeType: file.type,
				width: fileType.dimensions.width,
				height: fileType.dimensions.height,
			};
		}

		return {
			id: assetId,
			type: 'image',
			filename,
			remoteUrl,
			remoteFileKey,
			size: file.size,
			mimeType: file.type,
			width: fileType.dimensions.width,
			height: fileType.dimensions.height,
		};
	}

	if (file.type === 'image/svg+xml') {
		const svgText = await file.text();
		const dimensions = getSvgDimensions(svgText);
		return {
			id: assetId,
			type: 'image',
			filename,
			remoteUrl,
			remoteFileKey,
			size: file.size,
			mimeType: file.type,
			width: dimensions.width,
			height: dimensions.height,
		};
	}

	if (fileType.category === 'video' || fileType.category === 'audio') {
		const input = new Input({
			formats: ALL_FORMATS,
			source: new BlobSource(file),
		});

		try {
			const durationInSeconds = await input.computeDuration();
			const videoTrack = await input.getPrimaryVideoTrack();
			const audioTrack = await input.getPrimaryAudioTrack();

			if (!videoTrack && audioTrack) {
				return {
					id: assetId,
					type: 'audio',
					durationInSeconds,
					filename,
					remoteUrl,
					remoteFileKey,
					size: file.size,
					mimeType: file.type,
				};
			}

			if (videoTrack) {
				return {
					id: assetId,
					type: 'video',
					durationInSeconds,
					hasAudioTrack: audioTrack !== null,
					filename,
					remoteUrl,
					remoteFileKey,
					size: file.size,
					mimeType: file.type,
					width: videoTrack.displayWidth,
					height: videoTrack.displayHeight,
				};
			}

			throw new Error('No video or audio track found in media file');
		} finally {
			input.dispose();
		}
	}

	throw new Error('Unknown asset type');
};
