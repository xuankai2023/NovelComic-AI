import type {PlayerRef} from '@remotion/player';
import React, {useMemo} from 'react';
import {FEATURE_HIDE_TRACKS, FEATURE_ROLLING_EDITS} from '../../flags';
import type {TransformTimelineProperty} from '../../motion/transform-property-timeline';
import {
	isTrackHiddenByLayerGroup,
	isTrackLockedByLayerGroup,
} from '../../state/actions/layer-groups';
import {TrackType} from '../../state/types';
import {useAllItems, useFullState} from '../../utils/use-context';
import {TRANSFORM_GROUP_ROW_HEIGHT} from '../property-timeline/constants';
import {TransformPropertyKeyframes} from '../property-timeline/transform-property-keyframes';
import {TimelineItem} from '../timeline-item/timeline-item';
import type {TimelineTrackAndLayout} from '../utils/drag/calculate-track-heights';
import {TimelineTrackRollingEdits} from './timeline-track-rolling-edits';

const TimelineTrackUnmemoized = ({
	track,
	visibleFrames,
	layout,
	expandedItemId,
	visibleProperties,
	playerRef,
}: {
	track: TrackType;
	visibleFrames: number;
	layout: TimelineTrackAndLayout;
	expandedItemId: string | null;
	visibleProperties: readonly TransformTimelineProperty[];
	playerRef: React.RefObject<PlayerRef | null>;
}) => {
	const {items} = useAllItems();
	const fullState = useFullState();
	const propertyControlsLocked =
		Boolean(track.locked) ||
		track.hidden ||
		isTrackLockedByLayerGroup(fullState.undoableState, track.id) ||
		isTrackHiddenByLayerGroup(fullState.undoableState, track.id);

	const style = useMemo((): React.CSSProperties => {
		if (!FEATURE_HIDE_TRACKS) {
			return {};
		}

		return {
			opacity: track.hidden ? 0.3 : 1,
		};
	}, [track.hidden]);

	return (
		<div className="relative" data-hidden={track.hidden} style={style}>
			{track.items.map((item) => {
				return (
					<TimelineItem
						key={item}
						item={items[item]}
						visibleFrames={visibleFrames}
						top={layout.top}
						height={layout.baseHeight}
						trackMuted={track.muted}
						trackLocked={Boolean(track.locked)}
					/>
				);
			})}
			{expandedItemId &&
			track.items.includes(expandedItemId) &&
			items[expandedItemId]?.type === 'image' ? (
				<TransformPropertyKeyframes
					item={items[expandedItemId]}
					properties={visibleProperties}
					playerRef={playerRef}
					visibleFrames={visibleFrames}
					top={layout.top + layout.baseHeight + TRANSFORM_GROUP_ROW_HEIGHT}
					locked={propertyControlsLocked}
				/>
			) : null}
			{FEATURE_ROLLING_EDITS && (
				<TimelineTrackRollingEdits
					items={track.items}
					allItems={items}
					visibleFrames={visibleFrames}
					top={layout.top}
					height={layout.baseHeight}
				/>
			)}
		</div>
	);
};

export const TimelineTrack = React.memo(TimelineTrackUnmemoized);
