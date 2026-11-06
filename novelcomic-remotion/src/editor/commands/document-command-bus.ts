import type {
	AdjustmentContent,
	DocumentIssue,
	DocumentState,
	LayerEffectKind,
	LayerNode,
} from '../document';
import {normalizeDocument} from '../document/normalize';
import {validateDocument} from '../document/validate';
import {
	createDocumentCommand,
	createDocumentCommandId,
	type AppliedDocumentCommand,
	type DocumentCommand,
	type DocumentCommandHandler,
	type DocumentCommandTransactionResult,
	type DocumentCommandType,
} from './document-command-types';

const error = (code: string, path: string, message: string): DocumentIssue => ({
	severity: 'error',
	code,
	path,
	message,
});
const clone = <T>(value: T): T => structuredClone(value);
const valid = (document: DocumentState): DocumentState =>
	normalizeDocument(document);
const adjustmentContent = (layer: LayerNode): AdjustmentContent | undefined =>
	layer.kind === 'adjustment' &&
	!['pixel', 'group', 'text', 'shape'].includes(layer.content.kind)
		? (layer.content as AdjustmentContent)
		: undefined;
const effectKeys: readonly LayerEffectKind[] = [
	'stroke',
	'dropShadow',
	'colorOverlay',
	'innerShadow',
	'outerGlow',
	'innerGlow',
];
const effectKey = (value: string): value is LayerEffectKind =>
	effectKeys.includes(value as LayerEffectKind);
const layerWith = (
	document: DocumentState,
	layerId: string,
	changes: Partial<LayerNode>,
): DocumentState => {
	const layer = document.layers[layerId];
	return valid({
		...clone(document),
		layers: {...document.layers, [layerId]: {...layer, ...clone(changes)}},
	});
};
const withSiblingOrders = (
	document: DocumentState,
	parentId: string | null,
	excludedId: string | null,
	targetOrder: number,
): DocumentState => {
	const siblings = Object.values(document.layers)
		.filter((layer) => layer.parentId === parentId && layer.id !== excludedId)
		.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
	const insertion = Math.max(
		0,
		Math.min(Math.floor(targetOrder), siblings.length),
	);
	const next = clone(document);
	for (const [index, layer] of siblings.entries())
		next.layers[layer.id] = {
			...next.layers[layer.id],
			order: index >= insertion ? index + 1 : index,
		};
	if (parentId === null)
		next.rootLayerIds = Object.values(next.layers)
			.filter((layer) => layer.parentId === null)
			.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
			.map((layer) => layer.id);
	return next;
};

const handlers: {[K in DocumentCommandType]: DocumentCommandHandler<K>} = {
	'document.rename': {
		validate: (command) =>
			typeof command.payload.name === 'string' && command.payload.name.trim()
				? []
				: [error('INVALID_NAME', 'payload.name', 'Document name is required')],
		apply: (command, document) =>
			valid({...document, name: command.payload.name.trim()}),
		inverse: (command, before) =>
			createDocumentCommand({
				type: 'document.rename',
				projectId: before.projectId,
				expectedRevision: command.expectedRevision,
				payload: {name: before.name},
				transactionId: command.transactionId,
				mergeKey: command.mergeKey,
			}),
	},
	'layer.create': {
		validate: (command, document) => {
			const layer = command.payload.layer;
			if (!layer || document.layers[layer.id])
				return [
					error('LAYER_EXISTS', 'payload.layer.id', 'Layer id already exists'),
				];
			if (
				layer.parentId !== null &&
				document.layers[layer.parentId]?.kind !== 'group'
			)
				return [
					error(
						'INVALID_PARENT',
						'payload.layer.parentId',
						'Parent must be an existing group',
					),
				];
			return [];
		},
		apply: (command, document) => {
			const layer = clone(command.payload.layer);
			const parentId = layer.parentId;
			const next = {
				...clone(document),
				layers: {...document.layers, [layer.id]: layer},
			};
			if (parentId === null)
				next.rootLayerIds = [...document.rootLayerIds, layer.id];
			return valid(withSiblingOrders(next, parentId, null, layer.order));
		},
		inverse: (command, before) =>
			createDocumentCommand({
				type: 'layer.delete',
				projectId: before.projectId,
				expectedRevision: command.expectedRevision,
				payload: {layerId: command.payload.layer.id},
				transactionId: command.transactionId,
			}),
	},
	'layer.update': {
		validate: (command, document) => {
			const current = document.layers[command.payload.layerId];
			if (!current)
				return [
					error('LAYER_NOT_FOUND', 'payload.layerId', 'Layer does not exist'),
				];
			if (
				command.payload.changes.id &&
				command.payload.changes.id !== current.id
			)
				return [
					error(
						'LAYER_ID_IMMUTABLE',
						'payload.changes.id',
						'Layer id cannot be changed',
					),
				];
			if (
				command.payload.changes.parentId !== undefined &&
				command.payload.changes.parentId !== null &&
				document.layers[command.payload.changes.parentId]?.kind !== 'group'
			)
				return [
					error(
						'INVALID_PARENT',
						'payload.changes.parentId',
						'Parent must be an existing group',
					),
				];
			return [];
		},
		apply: (command, document) =>
			valid({
				...clone(document),
				layers: {
					...document.layers,
					[command.payload.layerId]: {
						...document.layers[command.payload.layerId],
						...clone(command.payload.changes),
					},
				},
			}),
		inverse: (command, before) => {
			const layer = before.layers[command.payload.layerId];
			const previous = Object.fromEntries(
				Object.keys(command.payload.changes).map((key) => [
					key,
					layer[key as keyof LayerNode],
				]),
			) as Partial<LayerNode>;
			return createDocumentCommand({
				type: 'layer.update',
				projectId: before.projectId,
				expectedRevision: command.expectedRevision,
				payload: {layerId: layer.id, changes: previous},
				transactionId: command.transactionId,
				mergeKey: command.mergeKey,
			});
		},
	},
	'layer.delete': {
		validate: (command, document) =>
			document.layers[command.payload.layerId]
				? []
				: [error('LAYER_NOT_FOUND', 'payload.layerId', 'Layer does not exist')],
		apply: (command, document) => {
			const next = clone(document);
			const remove = (id: string) => {
				for (const child of Object.values(next.layers))
					if (child.parentId === id) remove(child.id);
				delete next.layers[id];
			};
			remove(command.payload.layerId);
			next.rootLayerIds = next.rootLayerIds.filter(
				(id) => id !== command.payload.layerId,
			);
			for (const layer of Object.values(next.layers))
				if (
					layer.liveMask?.sourceLayerId &&
					!next.layers[layer.liveMask.sourceLayerId]
				)
					delete layer.liveMask;
			return valid(next);
		},
		inverse: (command, before) =>
			createDocumentCommand({
				type: 'project.replace',
				projectId: before.projectId,
				expectedRevision: command.expectedRevision,
				payload: {document: clone(before)},
				transactionId: command.transactionId,
			}),
	},
	'layer.reorder': {
		validate: (command, document) => {
			const layer = document.layers[command.payload.layerId];
			if (!layer)
				return [
					error('LAYER_NOT_FOUND', 'payload.layerId', 'Layer does not exist'),
				];
			if (
				command.payload.parentId !== null &&
				document.layers[command.payload.parentId]?.kind !== 'group'
			)
				return [
					error(
						'INVALID_PARENT',
						'payload.parentId',
						'Parent must be an existing group',
					),
				];
			if (command.payload.parentId === command.payload.layerId)
				return [
					error(
						'LAYER_CYCLE',
						'payload.parentId',
						'Layer cannot parent itself',
					),
				];
			let parent = command.payload.parentId;
			while (parent) {
				if (parent === layer.id)
					return [
						error(
							'LAYER_CYCLE',
							'payload.parentId',
							'Layer cannot move into its descendant',
						),
					];
				parent = document.layers[parent]?.parentId ?? null;
			}
			return Number.isInteger(command.payload.order) &&
				command.payload.order >= 0
				? []
				: [
						error(
							'ORDER_INVALID',
							'payload.order',
							'Order must be a non-negative integer',
						),
					];
		},
		apply: (command, document) => {
			const next = clone(document);
			const layer = next.layers[command.payload.layerId];
			const oldParent = layer.parentId;
			layer.parentId = command.payload.parentId;
			if (oldParent === null && command.payload.parentId !== null)
				next.rootLayerIds = next.rootLayerIds.filter((id) => id !== layer.id);
			if (oldParent !== null && command.payload.parentId === null)
				next.rootLayerIds = [...next.rootLayerIds, layer.id];
			return valid(
				withSiblingOrders(
					next,
					command.payload.parentId,
					layer.id,
					command.payload.order,
				),
			);
		},
		inverse: (command, before) => {
			const layer = before.layers[command.payload.layerId];
			return createDocumentCommand({
				type: 'layer.reorder',
				projectId: before.projectId,
				expectedRevision: command.expectedRevision,
				payload: {
					layerId: layer.id,
					parentId: layer.parentId,
					order: layer.order,
				},
				transactionId: command.transactionId,
			});
		},
	},
	'mask.attach': {
		validate: (command, document) => {
			const layer = document.layers[command.payload.layerId];
			if (!layer)
				return [
					error('LAYER_NOT_FOUND', 'payload.layerId', 'Layer does not exist'),
				];
			if (
				command.payload.asset.id !== command.payload.mask.assetId ||
				command.payload.asset.kind !== 'mask'
			)
				return [
					error(
						'MASK_ASSET_INVALID',
						'payload.asset',
						'Mask asset must match the attached mask',
					),
				];
			return [];
		},
		apply: (command, document) =>
			valid({
				...clone(document),
				assets: {
					...document.assets,
					[command.payload.asset.id]: clone(command.payload.asset),
				},
				layers: {
					...document.layers,
					[command.payload.layerId]: {
						...document.layers[command.payload.layerId],
						mask: clone(command.payload.mask),
					},
				},
			}),
		inverse: (command, before) =>
			before.layers[command.payload.layerId]?.mask
				? createDocumentCommand({
						type: 'project.replace',
						projectId: before.projectId,
						expectedRevision: command.expectedRevision,
						payload: {document: clone(before)},
						transactionId: command.transactionId,
					})
				: createDocumentCommand({
						type: 'mask.remove',
						projectId: before.projectId,
						expectedRevision: command.expectedRevision,
						payload: {layerId: command.payload.layerId, removeAsset: true},
						transactionId: command.transactionId,
					}),
	},
	'mask.update': {
		validate: (command, document) =>
			document.layers[command.payload.layerId]?.mask
				? []
				: [
						error(
							'MASK_NOT_FOUND',
							'payload.layerId',
							'Layer mask does not exist',
						),
					],
		apply: (command, document) => {
			const next = clone(document);
			const layer = next.layers[command.payload.layerId];
			layer.mask = {...layer.mask!, ...clone(command.payload.changes)};
			return valid(next);
		},
		inverse: (command, before) => {
			const mask = before.layers[command.payload.layerId].mask!;
			const changes = Object.fromEntries(
				Object.keys(command.payload.changes).map((key) => [
					key,
					mask[key as keyof typeof mask],
				]),
			);
			return createDocumentCommand({
				type: 'mask.update',
				projectId: before.projectId,
				expectedRevision: command.expectedRevision,
				payload: {layerId: command.payload.layerId, changes},
				transactionId: command.transactionId,
				mergeKey: command.mergeKey,
			});
		},
	},
	'mask.remove': {
		validate: (command, document) =>
			document.layers[command.payload.layerId]?.mask
				? []
				: [
						error(
							'MASK_NOT_FOUND',
							'payload.layerId',
							'Layer mask does not exist',
						),
					],
		apply: (command, document) => {
			const next = clone(document);
			const layer = next.layers[command.payload.layerId];
			const assetId = layer.mask!.assetId;
			delete layer.mask;
			if (
				command.payload.removeAsset &&
				!Object.values(next.layers).some(
					(candidate) => candidate.mask?.assetId === assetId,
				)
			)
				delete next.assets[assetId];
			return valid(next);
		},
		inverse: (command, before) =>
			createDocumentCommand({
				type: 'project.replace',
				projectId: before.projectId,
				expectedRevision: command.expectedRevision,
				payload: {document: clone(before)},
				transactionId: command.transactionId,
			}),
	},
	'mask.apply': {
		validate: (command, document) => {
			const layer = document.layers[command.payload.layerId];
			if (!layer?.mask)
				return [
					error(
						'MASK_NOT_FOUND',
						'payload.layerId',
						'Layer mask does not exist',
					),
				];
			if (layer.kind !== 'pixel' || command.payload.asset.kind !== 'raster')
				return [
					error(
						'MASK_APPLY_UNSUPPORTED',
						'payload.asset',
						'Applying a mask requires a raster layer and raster result',
					),
				];
			return [];
		},
		apply: (command, document) => {
			const next = clone(document);
			const layer = next.layers[command.payload.layerId];
			next.assets[command.payload.asset.id] = clone(command.payload.asset);
			layer.content = {kind: 'pixel', assetId: command.payload.asset.id};
			delete layer.mask;
			return valid(next);
		},
		inverse: (command, before) =>
			createDocumentCommand({
				type: 'project.replace',
				projectId: before.projectId,
				expectedRevision: command.expectedRevision,
				payload: {document: clone(before)},
				transactionId: command.transactionId,
			}),
	},
	'live-mask.set': {
		validate: (command, document) =>
			document.layers[command.payload.layerId] &&
			document.layers[command.payload.liveMask.sourceLayerId] &&
			command.payload.layerId !== command.payload.liveMask.sourceLayerId
				? []
				: [
						error(
							'LIVE_MASK_SOURCE_INVALID',
							'payload.liveMask.sourceLayerId',
							'Live mask source is invalid',
						),
					],
		apply: (command, document) =>
			valid({
				...clone(document),
				layers: {
					...document.layers,
					[command.payload.layerId]: {
						...document.layers[command.payload.layerId],
						liveMask: clone(command.payload.liveMask),
					},
				},
			}),
		inverse: (command, before) =>
			before.layers[command.payload.layerId]?.liveMask
				? createDocumentCommand({
						type: 'live-mask.set',
						projectId: before.projectId,
						expectedRevision: command.expectedRevision,
						payload: {
							layerId: command.payload.layerId,
							liveMask: clone(before.layers[command.payload.layerId].liveMask!),
						},
						transactionId: command.transactionId,
					})
				: createDocumentCommand({
						type: 'live-mask.remove',
						projectId: before.projectId,
						expectedRevision: command.expectedRevision,
						payload: {layerId: command.payload.layerId},
						transactionId: command.transactionId,
					}),
	},
	'live-mask.remove': {
		validate: (command, document) =>
			document.layers[command.payload.layerId]?.liveMask
				? []
				: [
						error(
							'LIVE_MASK_NOT_FOUND',
							'payload.layerId',
							'Live mask does not exist',
						),
					],
		apply: (command, document) => {
			const next = clone(document);
			delete next.layers[command.payload.layerId].liveMask;
			return valid(next);
		},
		inverse: (command, before) =>
			createDocumentCommand({
				type: 'live-mask.set',
				projectId: before.projectId,
				expectedRevision: command.expectedRevision,
				payload: {
					layerId: command.payload.layerId,
					liveMask: clone(before.layers[command.payload.layerId].liveMask!),
				},
				transactionId: command.transactionId,
			}),
	},
	'layer.transform': {
		validate: (command, document) => {
			const layer = document.layers[command.payload.layerId];
			if (!layer)
				return [
					error('LAYER_NOT_FOUND', 'payload.layerId', 'Layer does not exist'),
				];
			if (layer.locked)
				return [error('LAYER_LOCKED', 'payload.layerId', 'Layer is locked')];
			const transform = command.payload.transform;
			return transform &&
				Number.isFinite(transform.originX) &&
				Number.isFinite(transform.originY) &&
				Number.isFinite(transform.width) &&
				Number.isFinite(transform.height) &&
				Number.isFinite(transform.rotation) &&
				Number.isFinite(transform.scaleX) &&
				Number.isFinite(transform.scaleY) &&
				transform.width > 0 &&
				transform.height > 0 &&
				transform.scaleX !== 0 &&
				transform.scaleY !== 0
				? []
				: [
						error(
							'TRANSFORM_INVALID',
							'payload.transform',
							'Transform values must be finite and non-zero',
						),
					];
		},
		apply: (command, document) =>
			valid({
				...clone(document),
				layers: {
					...document.layers,
					[command.payload.layerId]: {
						...document.layers[command.payload.layerId],
						transform: clone(command.payload.transform),
					},
				},
			}),
		inverse: (command, before) =>
			createDocumentCommand({
				type: 'layer.transform',
				projectId: before.projectId,
				expectedRevision: command.expectedRevision,
				payload: {
					layerId: command.payload.layerId,
					transform: clone(before.layers[command.payload.layerId].transform),
				},
				transactionId: command.transactionId,
				mergeKey: command.mergeKey,
				}),
	},
	'adjustment.update': {
		validate: (command, document) => {
			const layer = document.layers[command.payload.layerId];
			if (!layer)
				return [error('LAYER_NOT_FOUND', 'payload.layerId', 'Layer does not exist')];
			if (layer.kind !== 'adjustment')
				return [error('ADJUSTMENT_LAYER_REQUIRED', 'payload.layerId', 'Adjustment commands require an adjustment layer')];
			return !adjustmentContent({...layer, content: command.payload.content})
				? [error('ADJUSTMENT_CONTENT_INVALID', 'payload.content', 'Adjustment content must be a supported adjustment kind')]
				: [];
		},
		apply: (command, document) => layerWith(document, command.payload.layerId, {content: clone(command.payload.content)}),
		inverse: (command, before) => createDocumentCommand({
			type: 'adjustment.update', projectId: before.projectId, expectedRevision: command.expectedRevision,
			payload: {layerId: command.payload.layerId, content: clone(before.layers[command.payload.layerId].content as AdjustmentContent)},
			transactionId: command.transactionId, mergeKey: command.mergeKey,
		}),
	},
	'effect.set': {
		validate: (command, document) => {
			if (!document.layers[command.payload.layerId]) return [error('LAYER_NOT_FOUND', 'payload.layerId', 'Layer does not exist')];
			return effectKey(command.payload.effect) ? [] : [error('EFFECT_KIND_INVALID', 'payload.effect', 'Unknown layer effect')];
		},
		apply: (command, document) => layerWith(document, command.payload.layerId, {
			effects: {...document.layers[command.payload.layerId].effects, [command.payload.effect]: clone(command.payload.value)},
		}),
		inverse: (command, before) => {
			const previous = before.layers[command.payload.layerId].effects?.[command.payload.effect];
			return previous ? createDocumentCommand({type: 'effect.set', projectId: before.projectId, expectedRevision: command.expectedRevision, payload: {layerId: command.payload.layerId, effect: command.payload.effect, value: clone(previous)}, transactionId: command.transactionId})
				: createDocumentCommand({type: 'effect.remove', projectId: before.projectId, expectedRevision: command.expectedRevision, payload: {layerId: command.payload.layerId, effect: command.payload.effect}, transactionId: command.transactionId});
		},
	},
	'effect.update': {
		validate: (command, document) => {
			const layer = document.layers[command.payload.layerId];
			if (!layer) return [error('LAYER_NOT_FOUND', 'payload.layerId', 'Layer does not exist')];
			if (!effectKey(command.payload.effect)) return [error('EFFECT_KIND_INVALID', 'payload.effect', 'Unknown layer effect')];
			return layer.effects?.[command.payload.effect] ? [] : [error('EFFECT_NOT_FOUND', 'payload.effect', 'Effect must be created before it can be edited')];
		},
		apply: (command, document) => {
			const layer = document.layers[command.payload.layerId];
			return layerWith(document, layer.id, {effects: {...layer.effects, [command.payload.effect]: {...layer.effects?.[command.payload.effect], ...clone(command.payload.changes)}}});
		},
		inverse: (command, before) => {
			const effect = before.layers[command.payload.layerId].effects?.[command.payload.effect];
			const changes = Object.fromEntries(Object.keys(command.payload.changes).map((key) => [key, effect?.[key as keyof typeof effect]]));
			return createDocumentCommand({type: 'effect.update', projectId: before.projectId, expectedRevision: command.expectedRevision, payload: {layerId: command.payload.layerId, effect: command.payload.effect, changes}, transactionId: command.transactionId, mergeKey: command.mergeKey});
		},
	},
	'effect.remove': {
		validate: (command, document) => document.layers[command.payload.layerId]?.effects?.[command.payload.effect] ? [] : [error('EFFECT_NOT_FOUND', 'payload.effect', 'Effect does not exist')],
		apply: (command, document) => {
			const next = clone(document);
			const effects = next.layers[command.payload.layerId].effects;
			if (effects) delete effects[command.payload.effect];
			if (effects && !Object.keys(effects).length) delete next.layers[command.payload.layerId].effects;
			return valid(next);
		},
		inverse: (command, before) => createDocumentCommand({type: 'effect.set', projectId: before.projectId, expectedRevision: command.expectedRevision, payload: {layerId: command.payload.layerId, effect: command.payload.effect, value: clone(before.layers[command.payload.layerId].effects![command.payload.effect]!)}, transactionId: command.transactionId}),
	},
	'text.update': {
		validate: (command, document) => document.layers[command.payload.layerId]?.kind === 'text' && document.layers[command.payload.layerId]?.content.kind === 'text' ? [] : [error('TEXT_LAYER_REQUIRED', 'payload.layerId', 'Text commands require a text layer')],
		apply: (command, document) => {
			const layer = document.layers[command.payload.layerId];
			return layerWith(document, layer.id, {content: {...layer.content, ...clone(command.payload.changes), kind: 'text'} as LayerNode['content']});
		},
		inverse: (command, before) => {
			const content = before.layers[command.payload.layerId].content;
			const changes = Object.fromEntries(Object.keys(command.payload.changes).map((key) => [key, content[key as keyof typeof content]]));
			return createDocumentCommand({type: 'text.update', projectId: before.projectId, expectedRevision: command.expectedRevision, payload: {layerId: command.payload.layerId, changes}, transactionId: command.transactionId, mergeKey: command.mergeKey});
		},
	},
	'shape.update': {
		validate: (command, document) => document.layers[command.payload.layerId]?.kind === 'shape' && document.layers[command.payload.layerId]?.content.kind === 'shape' ? [] : [error('SHAPE_LAYER_REQUIRED', 'payload.layerId', 'Shape commands require a shape layer')],
		apply: (command, document) => {
			const layer = document.layers[command.payload.layerId];
			return layerWith(document, layer.id, {content: {...layer.content, ...clone(command.payload.changes), kind: 'shape'} as LayerNode['content']});
		},
		inverse: (command, before) => {
			const content = before.layers[command.payload.layerId].content;
			const changes = Object.fromEntries(Object.keys(command.payload.changes).map((key) => [key, content[key as keyof typeof content]]));
			return createDocumentCommand({type: 'shape.update', projectId: before.projectId, expectedRevision: command.expectedRevision, payload: {layerId: command.payload.layerId, changes}, transactionId: command.transactionId, mergeKey: command.mergeKey});
		},
	},
		'selection.commit': {
		validate: (command) => {
			const selection = command.payload.selection;
			return !selection ||
				(Boolean(selection.id) &&
					Number.isFinite(selection.bounds.x) &&
					Number.isFinite(selection.bounds.y) &&
					Number.isFinite(selection.bounds.width) &&
					Number.isFinite(selection.bounds.height) &&
					selection.bounds.width >= 0 &&
					selection.bounds.height >= 0)
				? []
				: [
						error(
							'SELECTION_INVALID',
							'payload.selection',
							'Selection bounds are invalid',
						),
					];
		},
		apply: (command, document) => {
			const next = clone(document);
			if (command.payload.selection) {
				next.selections[command.payload.selection.id] = clone(
					command.payload.selection,
				);
			} else {
				delete next.selections['active-selection'];
			}
			return valid(next);
		},
		inverse: (command, before) =>
			createDocumentCommand({
				type: 'project.replace',
				projectId: before.projectId,
				expectedRevision: command.expectedRevision,
				payload: {document: clone(before)},
				transactionId: command.transactionId,
			}),
	},
	'project.replace': {
		validate: (command) => validateDocument(command.payload.document),
		apply: (command) => valid(clone(command.payload.document)),
		inverse: (command, before) =>
			createDocumentCommand({
				type: 'project.replace',
				projectId: before.projectId,
				expectedRevision: command.expectedRevision,
				payload: {document: clone(before)},
				transactionId: command.transactionId,
			}),
	},
	'asset.attach': {
		validate: (command, document) => {
			const asset = command.payload.asset;
			return asset && asset.id && !document.assets[asset.id]
				? []
				: [error('ASSET_EXISTS', 'payload.asset.id', 'Asset id already exists or is invalid')];
		},
		apply: (command, document) =>
			valid({
				...clone(document),
				assets: {...document.assets, [command.payload.asset.id]: clone(command.payload.asset)},
			}),
		inverse: (command, before) =>
			createDocumentCommand({
				type: 'project.replace',
				projectId: before.projectId,
				expectedRevision: command.expectedRevision,
				payload: {document: clone(before)},
				transactionId: command.transactionId,
			}),
		},
	'pixel.replace': {
		validate: (command, document) => {
			const layer = document.layers[command.payload.layerId];
			if (!layer) return [error('LAYER_NOT_FOUND', 'payload.layerId', 'Layer does not exist')];
			if (layer.kind !== 'pixel' || layer.content.kind !== 'pixel') return [error('PIXEL_LAYER_REQUIRED', 'payload.layerId', 'Pixel replacement requires a pixel layer')];
			return command.payload.asset.kind === 'raster' && Boolean(command.payload.asset.id) ? [] : [error('RASTER_ASSET_REQUIRED', 'payload.asset', 'Pixel replacement requires a raster asset')];
		},
		apply: (command, document) => {
			const next = clone(document);
			next.assets[command.payload.asset.id] = clone(command.payload.asset);
			next.layers[command.payload.layerId].content = {kind: 'pixel', assetId: command.payload.asset.id};
			return valid(next);
		},
		inverse: (command, before) => createDocumentCommand({type: 'project.replace', projectId: before.projectId, expectedRevision: command.expectedRevision, payload: {document: clone(before)}, transactionId: command.transactionId}),
	},
	'camera-raw.update': {
		validate: (command, document) => {
			const layer = document.layers[command.payload.layerId];
			return layer?.kind === 'adjustment' && layer.content.kind === 'camera-raw' ? [] : [error('CAMERA_RAW_LAYER_REQUIRED', 'payload.layerId', 'Camera Raw commands require a Camera Raw adjustment layer')];
		},
		apply: (command, document) => layerWith(document, command.payload.layerId, {content: {kind: 'camera-raw', settings: clone(command.payload.settings)}}),
		inverse: (command, before) => {
			const content = before.layers[command.payload.layerId].content;
			if (content.kind !== 'camera-raw') throw new Error('Camera Raw inverse requires Camera Raw content');
			return createDocumentCommand({type: 'camera-raw.update', projectId: before.projectId, expectedRevision: command.expectedRevision, payload: {layerId: command.payload.layerId, settings: clone(content.settings)}, transactionId: command.transactionId, mergeKey: command.mergeKey});
		},
	},
};

/* handlers['layer.transform'] = {
	validate: (command, document) => {
		const layer = document.layers[command.payload.layerId];
		if (!layer) return [error('LAYER_NOT_FOUND', 'payload.layerId', 'Layer does not exist')];
		if (layer.locked) return [error('LAYER_LOCKED', 'payload.layerId', 'Layer is locked')];
		const transform = command.payload.transform;
		return transform && Number.isFinite(transform.originX) && Number.isFinite(transform.originY) && Number.isFinite(transform.width) && Number.isFinite(transform.height) && Number.isFinite(transform.rotation) && Number.isFinite(transform.scaleX) && Number.isFinite(transform.scaleY) && transform.width > 0 && transform.height > 0 && transform.scaleX !== 0 && transform.scaleY !== 0 ? [] : [error('TRANSFORM_INVALID', 'payload.transform', 'Transform values must be finite and non-zero')];
	},
	apply: (command, document) => valid({...clone(document), layers: {...document.layers, [command.payload.layerId]: {...document.layers[command.payload.layerId], transform: clone(command.payload.transform)}}}),
	inverse: (command, before) => createDocumentCommand({type: 'layer.transform', projectId: before.projectId, expectedRevision: command.expectedRevision, payload: {layerId: command.payload.layerId, transform: clone(before.layers[command.payload.layerId].transform)}, transactionId: command.transactionId, mergeKey: command.mergeKey}),
};
handlers['selection.commit'] = {
	validate: (command) => { const selection = command.payload.selection; return !selection || (Boolean(selection.id) && Number.isFinite(selection.bounds.x) && Number.isFinite(selection.bounds.y) && Number.isFinite(selection.bounds.width) && Number.isFinite(selection.bounds.height) && selection.bounds.width >= 0 && selection.bounds.height >= 0) ? [] : [error('SELECTION_INVALID', 'payload.selection', 'Selection bounds are invalid')]; },
		apply: (command, document) => { const next = clone(document); if (command.payload.selection) next.selections[command.payload.selection.id] = clone(command.payload.selection); else delete next.selections['active-selection']; return valid(next); },
	inverse: (command, before) => createDocumentCommand({type: 'project.replace', projectId: before.projectId, expectedRevision: command.expectedRevision, payload: {document: clone(before)}, transactionId: command.transactionId}),
}; */

export class DocumentCommandValidationError extends Error {
	constructor(readonly issues: DocumentIssue[]) {
		super(issues[0]?.message ?? 'Invalid document command');
		this.name = 'DocumentCommandValidationError';
	}
}

export class DocumentCommandBus {
	validate(command: DocumentCommand, document: DocumentState): DocumentIssue[] {
		if (command.projectId !== document.projectId)
			return [
				error(
					'PROJECT_ID_MISMATCH',
					'projectId',
					'Command project does not match document',
				),
			];
		const handler = handlers[command.type] as DocumentCommandHandler;
		return handler
			? handler.validate(command, document)
			: [error('UNKNOWN_COMMAND', 'type', `Unknown command ${command.type}`)];
	}
	execute(
		document: DocumentState,
		command: DocumentCommand,
	): AppliedDocumentCommand {
		const issues = this.validate(command, document);
		if (issues.some((entry) => entry.severity === 'error'))
			throw new DocumentCommandValidationError(issues);
		const handler = handlers[command.type] as DocumentCommandHandler;
		const next = handler.apply(command, document);
		const postIssues = validateDocument(next);
		if (postIssues.some((entry) => entry.severity === 'error'))
			throw new DocumentCommandValidationError(postIssues);
		return {
			command,
			inverse: handler.inverse(command, document),
			document: next,
		};
	}
	executeTransaction(
		document: DocumentState,
		commands: readonly DocumentCommand[],
		transactionId = createDocumentCommandId('transaction'),
	): DocumentCommandTransactionResult {
		let next = document;
		const applied: DocumentCommand[] = [];
		const inverses: DocumentCommand[] = [];
		for (const source of commands) {
			const command = {...source, transactionId};
			const result = this.execute(next, command);
			next = result.document;
			applied.push(command);
			inverses.unshift({...result.inverse, transactionId});
		}
		return {document: next, commands: applied, inverses};
	}
}

export const documentCommandBus = new DocumentCommandBus();
