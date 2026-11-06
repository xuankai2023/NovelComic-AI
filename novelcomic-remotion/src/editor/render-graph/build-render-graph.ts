import type {DocumentState} from '../document';
import {evaluateDocumentFrame} from './evaluate-document-frame';
import type {EvaluatedDocumentFrame, RenderGraph, RenderQuality} from './types';

export type BuildRenderGraphInput = {
	document: DocumentState;
	frame?: number;
	quality?: RenderQuality;
};

export const buildRenderGraph = ({document, frame = 0, quality = 'preview'}: BuildRenderGraphInput): RenderGraph => {
	const evaluated = evaluateDocumentFrame({document, frame, quality});
	return {document: {documentId: document.documentId, width: document.width, height: document.height}, frame: evaluated, nodes: evaluated.nodes};
};

export const graphNodesForFrame = (frame: EvaluatedDocumentFrame) => frame.nodes;
