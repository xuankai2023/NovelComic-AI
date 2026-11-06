import type {PlayerRef} from '@remotion/player';
import {useTranslations} from 'next-intl';
import React, {useCallback, useRef} from 'react';
import {PauseIcon} from '../icons/pause';
import {PlayIcon} from '../icons/play';
import {useIsPlaying} from './use-is-playing';

const playPauseIconStyle: React.CSSProperties = {
	width: 14,
};

export const PlayPauseButton: React.FC<{
	playerRef: React.RefObject<PlayerRef | null>;
}> = ({playerRef}) => {
	const t = useTranslations('editor.playback');
	const buttonRef = useRef<HTMLButtonElement>(null);

	const playing = useIsPlaying(playerRef);

	const onToggle = useCallback(() => {
		playerRef.current?.toggle();
		buttonRef.current?.blur(); // remove focus when clicked to avoid conflict with player's keyboard controls
	}, [playerRef]);

	return (
		<button
			ref={buttonRef}
			onClick={onToggle}
			type="button"
			className="editor-starter-focus-ring p-2"
			aria-label={playing ? t('pause') : t('play')}
		>
			{playing ? (
				<PauseIcon style={playPauseIconStyle} />
			) : (
				<PlayIcon style={playPauseIconStyle} />
			)}
		</button>
	);
};
