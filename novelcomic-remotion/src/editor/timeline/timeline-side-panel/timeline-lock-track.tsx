import {Lock, Unlock} from 'lucide-react';
import {useCallback} from 'react';
import {setTrackLocked} from '../../state/actions/lock-track';
import {TrackType} from '../../state/types';
import {useWriteContext} from '../../utils/use-context';

export const TimelineLockTrack: React.FC<{
	track: TrackType;
}> = ({track}) => {
	const {setState} = useWriteContext();
	const locked = Boolean(track.locked);

	const onClick: React.MouseEventHandler<HTMLButtonElement> = useCallback(
		(e) => {
			e.stopPropagation();
			setState({
				update: (state) => setTrackLocked(state, track.id, !locked),
				commitToUndoStack: true,
			});
		},
		[locked, setState, track.id],
	);

	const label = locked ? 'Unlock Track' : 'Lock Track';
	const Icon = locked ? Lock : Unlock;

	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			className="text-editor-starter-text-faint hover:text-editor-starter-text flex h-6 w-6 items-center justify-center rounded-sm"
			onClick={onClick}
		>
			<Icon size={14} strokeWidth={2} />
		</button>
	);
};
