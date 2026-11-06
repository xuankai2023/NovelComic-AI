import React from 'react';
import {Composition} from 'remotion';
import {createEmptyDocument, type DocumentState} from '../editor/document';
import {COMP_NAME} from './constants';
import {CompositionWithContexts} from './main';

export type RootProps = {
	document: DocumentState;
	assetUrls?: Record<string, string>;
};

export const Root: React.FC = () => {
	return (
		<Composition
			id={COMP_NAME}
			component={CompositionWithContexts}
			calculateMetadata={({props}) => ({
				width: props.document.width,
				height: props.document.height,
				durationInFrames: props.document.animation?.durationInFrames ?? 1,
				fps: props.document.animation?.fps ?? 30,
				props,
			})}
			defaultProps={{document: createEmptyDocument()}}
		/>
	);
};
