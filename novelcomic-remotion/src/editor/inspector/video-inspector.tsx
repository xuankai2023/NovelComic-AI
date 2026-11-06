import React from 'react';
import {useTranslations} from 'next-intl';
import {GenerateCaptionSection} from '../captioning/caption-section';
import {
	FEATURE_ALIGNMENT_CONTROL,
	FEATURE_AUDIO_FADE_CONTROL,
	FEATURE_BORDER_RADIUS_CONTROL,
	FEATURE_CROP_CONTROL,
	FEATURE_CROPPING,
	FEATURE_DIMENSIONS_CONTROL,
	FEATURE_OPACITY_CONTROL,
	FEATURE_PLAYBACKRATE_CONTROL,
	FEATURE_POSITION_CONTROL,
	FEATURE_ROTATION_CONTROL,
	FEATURE_SOURCE_CONTROL,
	FEATURE_VISUAL_FADE_CONTROL,
	FEATURE_VOLUME_CONTROL,
} from '../flags';
import {VideoItem} from '../items/video/video-item-type';
import {useAssetFromItem} from '../utils/use-context';
import {InspectorLabel} from './components/inspector-label';
import {
	CollapsableInspectorSection,
	InspectorDivider,
} from './components/inspector-section';
import {AlignmentControls} from './controls/alignment-controls';
import {AudioFadeControls} from './controls/audio-fade-controls';
import {BorderRadiusControl} from './controls/border-radius-controls';
import {CropControls} from './controls/crop-controls';
import {DimensionsControls} from './controls/dimensions-controls';
import {FadeControls} from './controls/fade-controls';
import {OpacityControls} from './controls/opacity-controls';
import {PlaybackRateControls} from './controls/playback-rate-controls';
import {PositionControl} from './controls/position-control';
import {RotationControl} from './controls/rotation-controls';
import {SourceControls} from './controls/source-info/source-info';
import {VolumeControls} from './controls/volume-controls';

const VideoInspectorUnmemoized: React.FC<{
	item: VideoItem;
}> = ({item}) => {
	const t = useTranslations('editor.inspector.sections');
	const asset = useAssetFromItem(item);

	if (asset.type !== 'video') {
		throw new Error('Video inspector not supported for video assets');
	}

	return (
		<div>
			{FEATURE_SOURCE_CONTROL && <SourceControls item={item} />}
			<CollapsableInspectorSection
				summary={<InspectorLabel>{t('layout')}</InspectorLabel>}
				id={`layout-${item.id}`}
				defaultOpen
			>
				{FEATURE_ALIGNMENT_CONTROL && <AlignmentControls itemId={item.id} />}
				{FEATURE_POSITION_CONTROL && <PositionControl itemId={item.id} />}
				{FEATURE_DIMENSIONS_CONTROL && <DimensionsControls itemId={item.id} />}
				{FEATURE_ROTATION_CONTROL && (
					<RotationControl rotation={item.rotation} itemId={item.id} />
				)}
			</CollapsableInspectorSection>
			<InspectorDivider />
			<CollapsableInspectorSection
				summary={<InspectorLabel>{t('fill')}</InspectorLabel>}
				id={`fill-${item.id}`}
				defaultOpen
			>
				{FEATURE_OPACITY_CONTROL && (
					<OpacityControls opacity={item.opacity} itemId={item.id} />
				)}
				{FEATURE_BORDER_RADIUS_CONTROL && (
					<BorderRadiusControl
						borderRadius={item.borderRadius}
						borderRadiusType="fill"
						itemId={item.id}
					/>
				)}
			</CollapsableInspectorSection>
			{FEATURE_CROPPING && FEATURE_CROP_CONTROL && (
				<>
					<InspectorDivider />
					<CollapsableInspectorSection
						summary={<InspectorLabel>{t('crop')}</InspectorLabel>}
						id={`crop-${item.id}`}
						defaultOpen={false}
					>
						<CropControls itemId={item.id} />
					</CollapsableInspectorSection>
				</>
			)}
			<InspectorDivider />
			<CollapsableInspectorSection
				summary={<InspectorLabel>{t('video')}</InspectorLabel>}
				id={`video-${item.id}`}
				defaultOpen={false}
			>
				{FEATURE_PLAYBACKRATE_CONTROL && (
					<PlaybackRateControls
						playbackRate={item.playbackRate}
						itemId={item.id}
						assetId={item.assetId}
					/>
				)}
				{FEATURE_VISUAL_FADE_CONTROL && (
					<FadeControls
						fadeInDuration={item.fadeInDurationInSeconds}
						fadeOutDuration={item.fadeOutDurationInSeconds}
						itemId={item.id}
						durationInFrames={item.durationInFrames}
					/>
				)}
			</CollapsableInspectorSection>

			{asset.hasAudioTrack ? (
				<>
					<InspectorDivider />
					<CollapsableInspectorSection
						summary={<InspectorLabel>{t('audio')}</InspectorLabel>}
						id={`audio-${item.id}`}
						defaultOpen={false}
					>
						{FEATURE_VOLUME_CONTROL && (
							<VolumeControls
								decibelAdjustment={item.decibelAdjustment}
								itemId={item.id}
							/>
						)}
						{FEATURE_AUDIO_FADE_CONTROL && (
							<AudioFadeControls
								fadeInDuration={item.audioFadeInDurationInSeconds}
								fadeOutDuration={item.audioFadeOutDurationInSeconds}
								itemId={item.id}
								durationInFrames={item.durationInFrames}
							/>
						)}
					</CollapsableInspectorSection>
					<InspectorDivider />
					<GenerateCaptionSection item={item} />
				</>
			) : null}
		</div>
	);
};

export const VideoInspector = React.memo(VideoInspectorUnmemoized);
