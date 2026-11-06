import type {DocumentState} from '../document';
import type {RenderQuality} from './types';

export type DocumentCompositionProps = {
	document: DocumentState;
	assetUrls?: Record<string, string>;
	quality?: RenderQuality;
};

export const resolveDocumentAsset = (assetUrls: Record<string, string> | undefined) => (assetId: string) => assetUrls?.[assetId];
