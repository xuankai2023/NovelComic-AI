'use client';

import React from 'react';
import {getEyedropperSettings, setShowsSampleRing, subscribeEyedropperSettings} from '../tools/eyedropper/eyedropper-settings';

/** Compositor's eyedropper header: the sample-ring toggle. Sampling itself happens on the canvas. */
export const EyedropperOptions: React.FC = () => {
	const settings = React.useSyncExternalStore(subscribeEyedropperSettings, getEyedropperSettings, getEyedropperSettings);
	return (
		<label className="flex items-center gap-1.5">
			<input
				checked={settings.showsSampleRing}
				onChange={(event) => setShowsSampleRing(event.target.checked)}
				type="checkbox"
			/>
			采样环
		</label>
	);
};
