import React from 'react';
import type {DocumentState} from '../editor/document';
import {MainComposition} from '../editor/canvas/composition';

export type CompositionWithContextsProps = {
	document: DocumentState;
	assetUrls?: Record<string, string>;
};

/** Remotion is a thin adapter; document evaluation stays in render-graph. */
export const CompositionWithContexts: React.FC<CompositionWithContextsProps> = ({
	document,
	assetUrls,
}) => <MainComposition document={document} assetUrls={assetUrls} />;
