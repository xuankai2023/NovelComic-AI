import React from 'react';
import {AbsoluteFill, Img} from 'remotion';
import type {AdjustmentContent, DocumentColor, LayerContent} from '../document';
import {adjustmentStyle} from './render-adjustment';
import {effectsStyle} from './render-effects';
import {maskStyle, type MaskAssetResolver} from './render-mask';
import type {EvaluatedRenderLayer, RenderGraphNode} from './types';

export type RenderGraphAssetResolver = MaskAssetResolver &
	((assetId: string) => string | undefined);

const rgba = (value: DocumentColor) =>
	`rgba(${value.r}, ${value.g}, ${value.b}, ${value.a})`;
const rgbaWithOpacity = (value: DocumentColor, opacity: number) =>
	`rgba(${value.r}, ${value.g}, ${value.b}, ${Math.max(0, Math.min(1, value.a * opacity))})`;
const isAdjustmentContent = (
	content: LayerContent,
): content is AdjustmentContent =>
	!['pixel', 'group', 'text', 'shape'].includes(content.kind);

const layerStyle = (
	layer: EvaluatedRenderLayer,
	resolveAsset: RenderGraphAssetResolver,
	liveMaskUrl?: string,
): React.CSSProperties => ({
	position: 'absolute',
	left: layer.transform.x,
	top: layer.transform.y,
	width: layer.transform.width,
	height: layer.transform.height,
	opacity: layer.opacity,
	transform: `rotate(${layer.transform.rotation}deg) scale(${layer.transform.scaleX}, ${layer.transform.scaleY})`,
	transformOrigin: `${layer.transform.originX}px ${layer.transform.originY}px`,
	mixBlendMode: layer.blendMode,
	imageRendering:
		layer.transform.sampling === 'nearest' ? 'pixelated' : undefined,
	...maskStyle(layer, layer.effectiveMasks, resolveAsset, liveMaskUrl),
	...effectsStyle(layer.effects),
	pointerEvents: 'none',
});

const Shape: React.FC<{layer: EvaluatedRenderLayer}> = ({layer}) => {
	if (layer.content.kind !== 'shape') return null;
	const content = layer.content;
	if (content.shape === 'line')
		return (
			<div
				style={{
					position: 'absolute',
					left: 0,
					top: '50%',
					width: '100%',
					height: Math.max(1, content.strokeWidth || 1),
					background: rgba(content.stroke ?? content.fill),
					transform: 'translateY(-50%)',
				}}
			/>
		);
	return (
		<div
			style={{
				position: 'absolute',
				inset: 0,
				background: rgba(content.fill),
				border:
					content.stroke && content.strokeWidth > 0
						? `${content.strokeWidth}px solid ${rgba(content.stroke)}`
						: undefined,
				borderRadius:
					content.shape === 'ellipse' ? '50%' : content.cornerRadius,
			}}
		/>
	);
};

const Text: React.FC<{layer: EvaluatedRenderLayer}> = ({layer}) => {
	if (layer.content.kind !== 'text') return null;
	const content = layer.content;
	const runs = content.runs ?? [];
	if (!runs.length)
		return (
			<div
				style={{
					position: 'absolute',
					inset: 0,
					color: rgba(content.color),
					fontFamily: content.fontFamily,
					fontSize: content.fontSize,
					lineHeight: content.lineHeight,
					letterSpacing: content.letterSpacing,
					textAlign: content.align,
					whiteSpace: 'pre-wrap',
				}}
			>
				{content.text}
			</div>
		);
	return (
		<div
			style={{
				position: 'absolute',
				inset: 0,
				color: rgba(content.color),
				fontFamily: content.fontFamily,
				fontSize: content.fontSize,
				lineHeight: content.lineHeight,
				letterSpacing: content.letterSpacing,
				textAlign: content.align,
				whiteSpace: 'pre-wrap',
			}}
		>
			{runs.reduce<React.ReactNode[]>((parts, run, index) => {
				const previousEnd = index === 0 ? 0 : runs[index - 1]!.end;
				if (run.start > previousEnd) parts.push(content.text.slice(previousEnd, run.start));
				parts.push(
					<span key={`${run.start}-${run.end}`} style={{fontFamily: run.fontFamily, fontSize: run.fontSize, color: run.color ? rgba(run.color) : undefined}}>
						{content.text.slice(run.start, run.end)}
					</span>,
				);
				if (index === runs.length - 1 && run.end < content.text.length) parts.push(content.text.slice(run.end));
				return parts;
			}, [])}
		</div>
	);
};

export const RenderGraphNodeView: React.FC<{
	node: RenderGraphNode;
	resolveAsset: RenderGraphAssetResolver;
	liveMaskUrl?: string;
}> = ({node, resolveAsset, liveMaskUrl}) => {
	const layer = node.layer;
	if (!layer.visible) return null;
	const content = layer.content;
	const assetUrl =
		content.kind === 'pixel' ? resolveAsset(content.assetId) : undefined;
	const child =
		content.kind === 'pixel' ? (
			assetUrl ? (
				<Img
					src={assetUrl}
					style={{
						width: '100%',
						height: '100%',
						display: 'block',
						objectFit: 'fill',
					}}
				/>
			) : null
		) : content.kind === 'text' ? (
			<Text layer={layer} />
		) : content.kind === 'shape' ? (
			<Shape layer={layer} />
		) : null;
	if (
		layer.kind === 'adjustment' &&
		content.kind !== 'pixel' &&
		content.kind !== 'group' &&
		content.kind !== 'text' &&
		content.kind !== 'shape'
	)
		return (
			<AbsoluteFill style={adjustmentStyle(content, layer.opacity)}>
				{child}
			</AbsoluteFill>
		);
	return (
		<div
			data-render-layer-id={layer.id}
			style={layerStyle(layer, resolveAsset, liveMaskUrl)}
		>
			{child}
			{layer.effects?.colorOverlay?.enabled ? (
				<div
					style={{
						position: 'absolute',
						inset: 0,
						background: rgbaWithOpacity(
							layer.effects.colorOverlay.color,
							layer.effects.colorOverlay.opacity,
						),
						mixBlendMode: layer.effects.colorOverlay.blendMode,
						pointerEvents: 'none',
					}}
				/>
			) : null}
		</div>
	);
};

export const RenderGraphLayers: React.FC<{
	nodes: readonly RenderGraphNode[];
	resolveAsset?: RenderGraphAssetResolver;
}> = ({nodes, resolveAsset = () => undefined}) => {
	const adjustmentInputs = new Set(
		nodes.flatMap((node) =>
			node.kind === 'adjustment' ? node.inputNodeIds : [],
		),
	);
	const byId = new Map(nodes.map((node) => [node.layer.id, node]));
	const liveMaskUrl = (node: RenderGraphNode) => {
		const sourceId = node.layer.liveMask?.sourceLayerId;
		if (!sourceId) return undefined;
		const source = byId.get(sourceId)?.layer;
		return source?.content.kind === 'pixel'
			? resolveAsset(source.content.assetId)
			: undefined;
	};
	return (
		<AbsoluteFill style={{overflow: 'hidden', pointerEvents: 'none'}}>
			{nodes.map((node) => {
				if (node.kind === 'layer' && adjustmentInputs.has(node.layer.id))
					return null;
				if (
					node.kind === 'adjustment' &&
					isAdjustmentContent(node.layer.content)
				)
					return (
						<AbsoluteFill
							key={node.layer.id}
							style={adjustmentStyle(node.layer.content, node.layer.opacity)}
						>
							{node.inputNodeIds.map((id) => {
								const input = byId.get(id);
								return input ? (
									<RenderGraphNodeView
										key={id}
										node={input}
										resolveAsset={resolveAsset}
										liveMaskUrl={liveMaskUrl(input)}
									/>
								) : null;
							})}
						</AbsoluteFill>
					);
				return (
					<RenderGraphNodeView
						key={node.layer.id}
						node={node}
						resolveAsset={resolveAsset}
						liveMaskUrl={liveMaskUrl(node)}
					/>
				);
			})}
		</AbsoluteFill>
	);
};
