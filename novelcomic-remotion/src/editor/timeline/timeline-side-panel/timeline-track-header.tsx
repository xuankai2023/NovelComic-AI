import type {PlayerRef} from '@remotion/player';
import {ChevronDown, ChevronRight} from 'lucide-react';
import {useMemo} from 'react';
import {
	FEATURE_HIDE_TRACKS,
	FEATURE_MUTE_TRACKS,
	FEATURE_PROPERTY_TIMELINE,
} from '../../flags';
import type {TransformTimelineProperty} from '../../motion/transform-property-timeline';
import {
	isTrackHiddenByLayerGroup,
	isTrackLockedByLayerGroup,
} from '../../state/actions/layer-groups';
import {
	useAllItems,
	useFullState,
	useSelectedItems,
} from '../../utils/use-context';
import {TRANSFORM_GROUP_ROW_HEIGHT} from '../property-timeline/constants';
import {TransformPropertyHeaders} from '../property-timeline/transform-property-headers';
import {TimelineTrackAndLayout} from '../utils/drag/calculate-track-heights';
import {TimelineHideTrack} from './timeline-hide-track';
import {TimelineLockTrack} from './timeline-lock-track';
import {TimelineMuteTrack} from './timeline-mute-track';

const semanticLabels: Record<string, string> = {
	background: 'BG',
	foreground: 'FG',
	body: 'Body',
	head: 'Head',
	'arm-left': 'L Arm',
	'arm-right': 'R Arm',
	hair: 'Hair',
	'eye-open': 'Eye',
	'eye-closed': 'Eye',
	'mouth-closed': 'Mouth',
	'mouth-half': 'Mouth',
	'mouth-open': 'Mouth',
	effect: 'FX',
	dialogue: 'Dialogue',
	other: 'Other',
};

const getTrackTitle = (trackAndLayout: TimelineTrackAndLayout): string => {
	const track = trackAndLayout.track;
	return (
		track.name ??
		(track.semantic
			? (semanticLabels[track.semantic] ?? track.semantic)
			: null) ??
		'Track'
	);
};

export const TrackHeader = ({
	name,
	trackAndLayout,
	expandedItemId,
	visibleProperties,
	playerRef,
	onToggleProperties,
}: {
	name: string;
	trackAndLayout: TimelineTrackAndLayout;
	expandedItemId: string | null;
	visibleProperties: readonly TransformTimelineProperty[];
	playerRef: React.RefObject<PlayerRef | null>;
	onToggleProperties: (itemId: string) => void;
}) => {
	const {items} = useAllItems();
	const {selectedItems} = useSelectedItems();
	const fullState = useFullState();
	const propertyControlsLocked =
		Boolean(trackAndLayout.track.locked) ||
		isTrackLockedByLayerGroup(
			fullState.undoableState,
			trackAndLayout.track.id,
		) ||
		trackAndLayout.track.hidden ||
		isTrackHiddenByLayerGroup(fullState.undoableState, trackAndLayout.track.id);
	const imageItemId =
		trackAndLayout.track.items.find(
			(itemId) =>
				selectedItems.includes(itemId) && items[itemId]?.type === 'image',
		) ??
		trackAndLayout.track.items.find(
			(itemId) => items[itemId]?.type === 'image',
		) ??
		null;
	const imageItem =
		imageItemId && items[imageItemId]?.type === 'image'
			? items[imageItemId]
			: null;
	const expanded = Boolean(
		FEATURE_PROPERTY_TIMELINE && imageItem && expandedItemId === imageItem.id,
	);
	const style = useMemo(() => {
		return {
			height: trackAndLayout.baseHeight,
		};
	}, [trackAndLayout.baseHeight]);

	return (
		<div className="bg-editor-starter-panel w-full shrink-0 text-xs">
			<div
				className="group flex w-full items-center gap-2 truncate px-2"
				style={style}
			>
				<div className="text-editor-starter-text-faint w-5 text-right">
					{name}
				</div>
				{FEATURE_PROPERTY_TIMELINE && imageItem ? (
					<button
						type="button"
						className="ae-track-disclosure"
						title="Show Transform properties"
						onClick={() => onToggleProperties(imageItem.id)}
					>
						{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
					</button>
				) : (
					<span className="w-[18px]" />
				)}
				<div className="min-w-0 flex-1">
					<div
						className="text-editor-starter-text truncate font-medium"
						title={getTrackTitle(trackAndLayout)}
					>
						{getTrackTitle(trackAndLayout)}
					</div>
					{trackAndLayout.track.shotId ? (
						<div
							className="text-editor-starter-text-faint truncate text-[10px]"
							title={trackAndLayout.track.shotId}
						>
							{trackAndLayout.track.shotId}
						</div>
					) : null}
				</div>
				<div className="flex shrink-0">
					<TimelineLockTrack track={trackAndLayout.track} />
					{FEATURE_HIDE_TRACKS && (
						<TimelineHideTrack track={trackAndLayout.track} />
					)}
					{FEATURE_MUTE_TRACKS && (
						<TimelineMuteTrack track={trackAndLayout.track} />
					)}
				</div>
			</div>
			{expanded && imageItem ? (
				<>
					<div
						className="ae-transform-group-header"
						style={{height: TRANSFORM_GROUP_ROW_HEIGHT}}
					>
						Transform
					</div>
					<TransformPropertyHeaders
						item={imageItem}
						properties={visibleProperties}
						playerRef={playerRef}
						locked={propertyControlsLocked}
					/>
				</>
			) : null}
		</div>
	);
};
