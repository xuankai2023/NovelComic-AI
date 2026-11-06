import type {PlayerRef} from '@remotion/player';
import {createContext, useContext} from 'react';

export const EditorPlayerRefContext =
	createContext<React.RefObject<PlayerRef | null> | null>(null);

export const useEditorPlayerRef = () => {
	const playerRef = useContext(EditorPlayerRefContext);
	if (!playerRef) {
		throw new Error('EditorPlayerRefContext is not set');
	}
	return playerRef;
};
