import type {
	AssetRecord,
	DocumentIssue,
	DocumentState,
	LayerNode,
	LayerTransform,
	LiveMask,
	RasterMask,
	SelectionRecord,
	AdjustmentContent,
	LayerEffect,
	LayerEffectKind,
	ShapeLayerContent,
	TextLayerContent,
} from '../document';
import type {CameraRawSettings} from '../document/camera-raw';

export const DOCUMENT_COMMAND_TYPES = [
	'document.rename',
	'layer.create',
	'layer.update',
	'layer.delete',
	'layer.reorder',
	'mask.attach',
	'mask.update',
	'mask.remove',
	'mask.apply',
	'live-mask.set',
	'live-mask.remove',
	'layer.transform',
	'adjustment.update',
	'effect.set',
	'effect.update',
	'effect.remove',
	'text.update',
	'shape.update',
	'selection.commit',
	'project.replace',
	'asset.attach',
	'pixel.replace',
	'camera-raw.update',
] as const;

export type DocumentCommandType = (typeof DOCUMENT_COMMAND_TYPES)[number];

export type DocumentCommandPayloads = {
	'document.rename': {name: string};
	'layer.create': {layer: LayerNode};
	'layer.update': {layerId: string; changes: Partial<LayerNode>};
	'layer.delete': {layerId: string};
	'layer.reorder': {layerId: string; parentId: string | null; order: number};
	'mask.attach': {layerId: string; mask: RasterMask; asset: AssetRecord};
	'mask.update': {
		layerId: string;
		changes: Partial<Omit<RasterMask, 'assetId'>>;
	};
	'mask.remove': {layerId: string; removeAsset?: boolean};
	'mask.apply': {layerId: string; asset: AssetRecord};
	'live-mask.set': {layerId: string; liveMask: LiveMask};
	'live-mask.remove': {layerId: string};
	'layer.transform': {layerId: string; transform: LayerTransform};
	'adjustment.update': {layerId: string; content: AdjustmentContent};
	'effect.set': {
		layerId: string;
		effect: LayerEffectKind;
		value: LayerEffect;
	};
	'effect.update': {
		layerId: string;
		effect: LayerEffectKind;
		changes: Partial<LayerEffect>;
	};
	'effect.remove': {layerId: string; effect: LayerEffectKind};
	'text.update': {
		layerId: string;
		changes: Partial<Omit<TextLayerContent, 'kind'>>;
	};
	'shape.update': {
		layerId: string;
		changes: Partial<Omit<ShapeLayerContent, 'kind'>>;
	};
	'selection.commit': {selection: SelectionRecord | null};
	'project.replace': {document: DocumentState};
	'asset.attach': {asset: AssetRecord};
	'pixel.replace': {layerId: string; asset: AssetRecord};
	'camera-raw.update': {layerId: string; settings: CameraRawSettings};
};

export type DocumentCommand<
	TType extends DocumentCommandType = DocumentCommandType,
> = {
	id: string;
	requestId: string;
	projectId: string;
	expectedRevision: number;
	type: TType;
	payload: DocumentCommandPayloads[TType];
	transactionId?: string;
	mergeKey?: string;
	createdAt: string;
};

export type DocumentCommandHandler<
	TType extends DocumentCommandType = DocumentCommandType,
> = {
	validate: (
		command: DocumentCommand<TType>,
		document: DocumentState,
	) => DocumentIssue[];
	apply: (
		command: DocumentCommand<TType>,
		document: DocumentState,
	) => DocumentState;
	inverse: (
		command: DocumentCommand<TType>,
		before: DocumentState,
	) => DocumentCommand;
};

export type AppliedDocumentCommand = {
	command: DocumentCommand;
	inverse: DocumentCommand;
	document: DocumentState;
};

export type DocumentCommandTransactionResult = {
	document: DocumentState;
	commands: DocumentCommand[];
	inverses: DocumentCommand[];
};

export const createDocumentCommandId = (
	prefix = 'document-command',
): string => {
	if (typeof globalThis.crypto?.randomUUID === 'function')
		return `${prefix}-${globalThis.crypto.randomUUID()}`;
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

export const createDocumentCommand = <TType extends DocumentCommandType>({
	type,
	payload,
	projectId,
	expectedRevision = 0,
	requestId = createDocumentCommandId('request'),
	id = createDocumentCommandId(type),
	transactionId,
	mergeKey,
	createdAt = new Date().toISOString(),
}: {
	type: TType;
	payload: DocumentCommandPayloads[TType];
	projectId: string;
	expectedRevision?: number;
	requestId?: string;
	id?: string;
	transactionId?: string;
	mergeKey?: string;
	createdAt?: string;
}): DocumentCommand<TType> => ({
	type,
	payload,
	projectId,
	expectedRevision,
	requestId,
	id,
	createdAt,
	...(transactionId ? {transactionId} : {}),
	...(mergeKey ? {mergeKey} : {}),
});
