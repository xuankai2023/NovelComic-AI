import {useMemo} from 'react';
import {TRACK_DIVIDER_HEIGHT} from '../state/items';
import {useShots, useTimelineHeight} from '../utils/use-context';
import {TICKS_HEIGHT} from './ticks/constants';

export const TimelineShotRegions: React.FC<{
	timelineWidth: number;
	visibleFrames: number;
}> = ({timelineWidth, visibleFrames}) => {
	const {shots} = useShots();
	const timelineHeight = useTimelineHeight();

	const regions = useMemo(() => {
		if (visibleFrames <= 0) {
			return [];
		}

		return shots.map((shot, index) => {
			const left = (shot.from / visibleFrames) * timelineWidth;
			const width = (shot.durationInFrames / visibleFrames) * timelineWidth;
			return {
				shot,
				index,
				left,
				width,
			};
		});
	}, [shots, timelineWidth, visibleFrames]);

	if (regions.length === 0) {
		return null;
	}

	return (
		<div
			className="pointer-events-none absolute top-0 left-0"
			style={{
				height: timelineHeight - TICKS_HEIGHT,
				width: timelineWidth,
			}}
		>
			{regions.map(({shot, index, left, width}) => (
				<div
					key={shot.id}
					className="absolute top-0 border-l border-white/10"
					style={{
						left,
						width: Math.max(1, width),
						height: timelineHeight - TICKS_HEIGHT,
						backgroundColor:
							index % 2 === 0
								? 'rgba(85, 120, 255, 0.06)'
								: 'rgba(255, 255, 255, 0.035)',
					}}
				>
					<div
						className="text-editor-starter-text-faint h-[18px] truncate border-b border-white/10 bg-black/15 px-1 text-[10px] leading-[18px]"
						title={`${shot.name} (${shot.from}-${shot.from + shot.durationInFrames - 1})`}
					>
						{shot.name}
						{shot.transitionOut?.type === 'crossfade'
							? ` · crossfade ${shot.transitionOut.durationInFrames}f`
							: ''}
					</div>
					{shot.transitionOut?.type === 'crossfade' ? (
						<div
							className="border-editor-starter-accent/60 bg-editor-starter-accent/10 absolute top-[18px] right-0 border-l"
							style={{
								width: Math.max(
									2,
									(shot.transitionOut.durationInFrames / visibleFrames) *
										timelineWidth,
								),
								height:
									timelineHeight - TICKS_HEIGHT - 18 - TRACK_DIVIDER_HEIGHT,
							}}
						/>
					) : null}
				</div>
			))}
		</div>
	);
};
