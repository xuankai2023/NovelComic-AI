'use client';

import React from 'react';
import {Toaster} from 'sonner';
import {useTheme} from '../theme/theme-provider';
import {EditorFeedbackMessagesSync} from './i18n/editor-feedback-messages-sync';
import {CompositorShell} from './workspace/compositor-shell';

/** Compositor-first editor entry point. */
export const Editor: React.FC = () => {
	const {resolvedTheme} = useTheme();
	return (
		<div className="h-dvh w-screen overflow-hidden bg-black p-1.5">
			<EditorFeedbackMessagesSync />
			<CompositorShell />
			<Toaster theme={resolvedTheme} />
		</div>
	);
};
