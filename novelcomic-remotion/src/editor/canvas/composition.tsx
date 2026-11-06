import type {PlayerRef} from '@remotion/player';
import {useMemo} from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {createEmptyDocument, type DocumentState} from '../document';
import {buildRenderGraph} from '../render-graph/build-render-graph';
import {RenderGraphLayers} from '../render-graph/render-layer';
import {resolveDocumentAsset} from '../render-graph/remotion-props';

export type MainCompositionProps = {
	playerRef?: React.RefObject<PlayerRef | null> | null;
	document?: DocumentState;
	assetUrls?: Record<string, string>;
};

/** The one render entry shared by the browser Player and Remotion renderer. */
export const MainComposition: React.FC<MainCompositionProps> = ({
	document = createEmptyDocument(),
	assetUrls,
}) => {
	const frame = useCurrentFrame();
	const graph = useMemo(
		() => buildRenderGraph({document, frame, quality: 'preview'}),
		[document, frame],
	);
	return (
		<AbsoluteFill
			style={{width: document.width, height: document.height, overflow: 'hidden'}}
			data-render-graph-document={document.documentId}
		>
			<RenderGraphLayers
				nodes={graph.nodes}
				resolveAsset={resolveDocumentAsset(assetUrls)}
			/>
		</AbsoluteFill>
	);
};
