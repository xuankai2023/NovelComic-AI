import type {
	BlendMode,
	DocumentColor,
	DocumentState,
	LayerContent,
	LayerEffects,
	LayerTransform,
	RasterMask,
} from '../document';

export type RenderQuality = 'draft' | 'preview' | 'final';

export type EvaluatedLayerTransform = LayerTransform & {
	x: number;
	y: number;
	opacity: number;
	worldScaleX: number;
	worldScaleY: number;
	worldRotation: number;
};

export type EvaluatedMask = {
	mask: RasterMask;
	sourceLayerId?: string;
	transform: EvaluatedLayerTransform;
};

export type EvaluatedRenderLayer = {
	id: string;
	name: string;
	kind: 'pixel' | 'group' | 'adjustment' | 'text' | 'shape';
	parentId: string | null;
	order: number;
	visible: boolean;
	locked: boolean;
	opacity: number;
	blendMode: BlendMode;
	transform: EvaluatedLayerTransform;
	content: LayerContent;
	mask?: EvaluatedMask;
	effectiveMasks: EvaluatedMask[];
	liveMask?: {
		sourceLayerId: string;
		mode: 'alpha' | 'alpha-inverted' | 'luma' | 'luma-inverted';
	};
	effects?: LayerEffects;
	ancestors: string[];
};

export type RenderGraphNode =
	| {kind: 'layer'; layer: EvaluatedRenderLayer}
	| {kind: 'adjustment'; layer: EvaluatedRenderLayer; inputNodeIds: string[]};

export type EvaluatedDocumentFrame = {
	documentId: string;
	frame: number;
	width: number;
	height: number;
	quality: RenderQuality;
	nodes: RenderGraphNode[];
	/** Alias kept for render consumers that use layer terminology. */
	layers: EvaluatedRenderLayer[];
	background: DocumentColor;
};

export type RenderGraph = {
	document: Pick<DocumentState, 'documentId' | 'width' | 'height'>;
	frame: EvaluatedDocumentFrame;
	nodes: RenderGraphNode[];
};
