import {Lock} from 'lucide-react';
import {memo} from 'react';
import {EditorStarterAsset} from '../../assets/assets';
import {RequireCachedAsset} from '../../caching/require-cached-asset';
import {
	FEATURE_AUDIO_WAVEFORM_FOR_VIDEO_ITEM,
	FEATURE_FILMSTRIP,
	FEATURE_TIMELINE_VOLUME_CONTROL,
	FEATURE_VISUAL_FADE_CONTROL,
	FEATURE_WAVEFORM,
} from '../../flags';
import {AudioItem} from '../../items/audio/audio-item-type';
import {EditorStarterItem} from '../../items/item-type';
import {VideoItem} from '../../items/video/video-item-type';
import {TRACK_PADDING} from '../../state/items';
import {getCanFadeVisual} from '../../utils/fade';
import {shouldShowItemHeader} from '../../utils/position-utils';
import {useAssetIfApplicable, useFps} from '../../utils/use-context';
import {useTimelineSize} from '../utils/use-timeline-size';
import {FadeCurve} from './timeline-item-fade-control/fade-curve';
import {
	FILMSTRIP_HEIGHT_IF_THERE_IS_AUDIO,
	TimelineItemFilmStrip,
} from './timeline-item-film-strip/timeline-item-film-strip';
import {TimelineItemHeader} from './timeline-item-header';
import {TIMELINE_ITEM_BORDER_WIDTH} from './timeline-item-layout';
import {TimelineItemPreview} from './timeline-item-preview';
import {TimelineItemVolumeControl} from './timeline-item-volume-control/timeline-item-volume-control';
import {TimelineItemWaveform} from './timeline-item-waveform/timeline-item-waveform';

const shouldShowAudioWaveform = ({
	item,
	asset,
}: {
	item: EditorStarterItem;
	asset: EditorStarterAsset | null;
}) => {
	if (!FEATURE_WAVEFORM) {
		return false;
	}

	if (item.type === 'audio') {
		return true;
	}

	if (item.type === 'video') {
		if (!asset || asset.type !== 'video') {
			throw new Error('Expected video asset in shouldShowAudioWaveform');
		}

		return FEATURE_AUDIO_WAVEFORM_FOR_VIDEO_ITEM && asset.hasAudioTrack;
	}

	// Add all item types that don't have audio waveform here
	if (
		item.type === 'captions' ||
		item.type === 'gif' ||
		item.type === 'text' ||
		item.type === 'solid' ||
		item.type === 'image'
	) {
		return false;
	}

	throw new Error('Invalid item type: ' + (item satisfies never));
};

const getMotionBadges = (item: EditorStarterItem): string[] => {
	if (item.type !== 'image') {
		return [];
	}

	const badges: string[] = [];
	if (item.motion?.transform) {
		badges.push('Motion');
	}

	if (item.motion?.spriteStates && item.motion.spriteStates.length > 0) {
		badges.push('Sprite');
	}

	if (item.motion?.preset?.id) {
		badges.push(item.motion.preset.id);
	}

	return badges;
};

export const TimelineItemContent = memo(
	({
		item,
		height,
		width,
		roundedDifference,
		trackMuted,
		trackLocked,
	}: {
		item: EditorStarterItem;
		height: number;
		width: number;
		roundedDifference: number;
		trackMuted: boolean;
		trackLocked: boolean;
	}) => {
		const {fps} = useFps();
		const asset = useAssetIfApplicable(item);
		const {timelineWidth} = useTimelineSize();

		if (timelineWidth === null) {
			throw new Error('Timeline width is null');
		}

		const filmstripHeight =
			asset?.type === 'video' && !asset.hasAudioTrack
				? height
				: FILMSTRIP_HEIGHT_IF_THERE_IS_AUDIO;

		const motionBadges = getMotionBadges(item);

		return (
			<>
				<div className="absolute h-full w-full overflow-hidden rounded-[6px]">
					<TimelineItemPreview item={item} />
					{item.type === 'video' && FEATURE_FILMSTRIP && asset && (
						<RequireCachedAsset asset={asset}>
							<TimelineItemFilmStrip
								item={item}
								startFrom={item.videoStartFromInSeconds * fps}
								durationInFrames={item.durationInFrames}
								fps={fps}
								roundedDifference={roundedDifference}
								height={filmstripHeight}
								playbackRate={item.playbackRate}
							/>
						</RequireCachedAsset>
					)}
					{getCanFadeVisual(item) && FEATURE_VISUAL_FADE_CONTROL && (
						<FadeCurve
							item={item}
							height={
								item.type === 'video'
									? filmstripHeight
									: height - TRACK_PADDING - TIMELINE_ITEM_BORDER_WIDTH * 2
							}
							width={width}
							fadeType="visual"
						/>
					)}
					{asset && shouldShowAudioWaveform({item, asset}) ? (
						<RequireCachedAsset asset={asset}>
							<TimelineItemWaveform
								trackHeight={height}
								item={item as AudioItem | VideoItem}
								timelineWidth={timelineWidth}
								roundedDifference={roundedDifference}
								trackMuted={trackMuted}
							>
								{FEATURE_TIMELINE_VOLUME_CONTROL ? (
									<TimelineItemVolumeControl
										item={item as AudioItem | VideoItem}
									/>
								) : null}
							</TimelineItemWaveform>
						</RequireCachedAsset>
					) : null}
					{shouldShowItemHeader(item) && asset && asset.filename ? (
						<TimelineItemHeader filename={asset.filename} />
					) : null}
					{trackLocked || motionBadges.length > 0 ? (
						<div className="pointer-events-none absolute right-1 bottom-1 flex max-w-[calc(100%-8px)] items-center gap-1 overflow-hidden">
							{trackLocked ? (
								<span
									className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-black/65 text-white"
									title="Locked track"
								>
									<Lock size={12} strokeWidth={2.4} />
								</span>
							) : null}
							{motionBadges.map((badge) => (
								<span
									key={badge}
									className="truncate rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white"
									title={badge}
								>
									{badge}
								</span>
							))}
						</div>
					) : null}
				</div>
			</>
		);
	},
);

TimelineItemContent.displayName = 'TimelineItemContent';
