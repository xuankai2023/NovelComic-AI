import React from 'react';
import {TextButton} from '../action-row/text-button';
import {isTimelineEmpty} from '../utils/is-timeline-empty';
import {useTracks} from '../utils/use-context';

export const TriggerRenderButton: React.FC<{
	onTrigger: () => void;
	disabled?: boolean;
}> = ({onTrigger, disabled: externallyDisabled = false}) => {
	const {tracks} = useTracks();

	const disabled = externallyDisabled || isTimelineEmpty(tracks);

	return (
		<TextButton onClick={onTrigger} disabled={disabled}>
			<div>Render video</div>
		</TextButton>
	);
};
