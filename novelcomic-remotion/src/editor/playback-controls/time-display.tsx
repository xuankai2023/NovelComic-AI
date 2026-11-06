import {PlayerRef} from '@remotion/player';
import {useTranslations} from 'next-intl';
import {renderFrame} from '../utils/render-frame';
import {useTimelinePosition} from '../utils/use-timeline-position';

export function CurrentTimeDisplay({
	playerRef,
	fps,
}: {
	playerRef: React.RefObject<PlayerRef | null>;
	fps: number;
}) {
	const t = useTranslations('editor.playback');
	const currentFrame = useTimelinePosition({playerRef});

	return (
		<div
			title={t('currentTime')}
			className="text-xs tabular-nums opacity-80 select-none sm:text-sm"
		>
			{renderFrame(currentFrame, fps)}
		</div>
	);
}
