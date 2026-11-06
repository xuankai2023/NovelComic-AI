import type {PlayerRef} from '@remotion/player';
import React from 'react';
import type {TransformTimelineProperty} from '../motion/transform-property-timeline';
import {TimelineTrack} from './timeline-track/timeline-track';
import {TimelineTrackAndLayout} from './utils/drag/calculate-track-heights';

const TimelineTracksUnmemoized: React.FC<{
	tracks: TimelineTrackAndLayout[];
	visibleFrames: number;
	expandedItemId: string | null;
	visibleProperties: readonly TransformTimelineProperty[];
	playerRef: React.RefObject<PlayerRef | null>;
}> = ({
	tracks,
	visibleFrames,
	expandedItemId,
	visibleProperties,
	playerRef,
}) => {
	return tracks.map((trackAndLayout) => {
		return (
			<TimelineTrack
				key={trackAndLayout.track.id}
				track={trackAndLayout.track}
				visibleFrames={visibleFrames}
				layout={trackAndLayout}
				expandedItemId={expandedItemId}
				visibleProperties={visibleProperties}
				playerRef={playerRef}
			/>
		);
	});
};

export const TimelineTracks = React.memo(TimelineTracksUnmemoized);
