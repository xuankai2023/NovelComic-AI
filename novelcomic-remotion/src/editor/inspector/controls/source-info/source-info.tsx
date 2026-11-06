import {useTranslations} from 'next-intl';
import {AudioItem} from '../../../items/audio/audio-item-type';
import {GifItem} from '../../../items/gif/gif-item-type';
import {ImageItem} from '../../../items/image/image-item-type';
import {VideoItem} from '../../../items/video/video-item-type';
import {secondsToTimeString} from '../../../utils/seconds-to-time-string';
import {useAssetFromItem, useAssetStatus} from '../../../utils/use-context';
import {InspectorLabel} from '../../components/inspector-label';
import {
	CollapsableInspectorSection,
	InspectorDivider,
} from '../../components/inspector-section';
import {UploadInfo} from './upload-info';

export const SourceInfoContent: React.FC<{
	item: VideoItem | ImageItem | GifItem | AudioItem;
}> = ({item}) => {
	const asset = useAssetFromItem(item);
	const {assetStatus} = useAssetStatus();
	const currentAssetStatus = assetStatus[asset.id];

	const duration =
		'durationInSeconds' in asset ? asset.durationInSeconds : null;

	return (
		<div className="text-xs leading-relaxed text-editor-starter-text-muted">
			<div>{asset.filename}</div>
			{duration !== null && <div>{secondsToTimeString(duration)}</div>}
			{currentAssetStatus && (
				<UploadInfo asset={asset} status={currentAssetStatus} />
			)}
		</div>
	);
};

export const SourceControls: React.FC<{
	item: VideoItem | ImageItem | GifItem | AudioItem;
}> = ({item}) => {
	const t = useTranslations('editor.inspector.sections');

	return (
		<>
			<CollapsableInspectorSection
				summary={<InspectorLabel>{t('source')}</InspectorLabel>}
				id={`source-${item.id}`}
				defaultOpen
			>
				<SourceInfoContent item={item} />
			</CollapsableInspectorSection>
			<InspectorDivider />
		</>
	);
};
