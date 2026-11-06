import React, {createContext, useContext} from 'react';
import {AbsoluteFill, Img, useCurrentFrame, useVideoConfig} from 'remotion';
import {sourceBoundsToComposition} from '../comic/source-to-composition';
import type {Shot} from '../comic/types';
import {FullStateContext} from '../context-provider';
import {
	useAssets,
	useOptionalAssetFromAssetId,
	useShots,
} from '../utils/use-context';
import {
	DEFAULT_QUALITY_PREVIEW_VISIBILITY,
	QUALITY_PREVIEW_MODES,
	diagnosticValue,
	getQualityTrackPlan,
	isCleanPlateTrack,
	isComicEnhancementTrack,
	isCutoutTrack,
	isSourcePanelTrack,
	summarizeQualityIssues,
	type QualityIssueSummary,
	type QualityPreviewMode,
	type QualityPreviewVisibility,
	type QualityTrackPlan,
} from './quality-preview-core';

export {
	DEFAULT_QUALITY_PREVIEW_VISIBILITY,
	QUALITY_PREVIEW_MODES,
	getQualityTrackPlan,
	isCleanPlateTrack,
	isComicEnhancementTrack,
	isCutoutTrack,
	isSourcePanelTrack,
	summarizeQualityIssues,
	type QualityIssueSummary,
	type QualityPreviewMode,
	type QualityPreviewVisibility,
	type QualityTrackPlan,
};

export type QualityPreviewState = {
	mode: QualityPreviewMode;
	setMode: (mode: QualityPreviewMode) => void;
	visibility: QualityPreviewVisibility;
	setVisibility: (
		visibility:
			| QualityPreviewVisibility
			| ((value: QualityPreviewVisibility) => QualityPreviewVisibility),
	) => void;
};

const QualityPreviewContext = createContext<QualityPreviewState>({
	mode: 'normal',
	setMode: () => undefined,
	visibility: DEFAULT_QUALITY_PREVIEW_VISIBILITY,
	setVisibility: () => undefined,
});

export const QualityPreviewProvider: React.FC<{
	children: React.ReactNode;
	value: QualityPreviewState;
}> = ({children, value}) => {
	return (
		<QualityPreviewContext.Provider value={value}>
			{children}
		</QualityPreviewContext.Provider>
	);
};

export const useQualityPreview = (): QualityPreviewState => {
	return useContext(QualityPreviewContext);
};

const MaskAssetImage: React.FC<{
	assetId: string;
	sourceCanvas: {width: number; height: number};
	bounds: {x: number; y: number; width: number; height: number};
}> = ({assetId, sourceCanvas, bounds}) => {
	const asset = useOptionalAssetFromAssetId(assetId);
	const {width: compositionWidth, height: compositionHeight} = useVideoConfig();
	if (!asset || asset.type !== 'image' || !asset.remoteUrl) {
		return null;
	}

	const src = asset.remoteUrl;
	const isFullCanvas =
		asset.width === sourceCanvas.width && asset.height === sourceCanvas.height;
	const geometry = isFullCanvas
		? {
				left: 0,
				top: 0,
				width: compositionWidth,
				height: compositionHeight,
			}
		: (() => {
				const scaled = sourceBoundsToComposition(bounds, sourceCanvas, {
					width: compositionWidth,
					height: compositionHeight,
				});
				return {
					left: scaled.x,
					top: scaled.y,
					width: scaled.width,
					height: scaled.height,
				};
			})();

	return (
		<Img
			crossOrigin="anonymous"
			src={src}
			style={{
				position: 'absolute',
				left: geometry.left,
				top: geometry.top,
				width: geometry.width,
				height: geometry.height,
				objectFit: 'fill',
				opacity: 0.8,
				mixBlendMode: 'screen',
			}}
		/>
	);
};

export const MaskPreviewOverlay: React.FC = () => {
	const {mode} = useQualityPreview();
	const state = useContext(FullStateContext);
	const {assets} = useAssets();
	const {shots} = useShots();
	const frame = useCurrentFrame();
	if (mode !== 'mask') {
		return null;
	}

	const currentShot = shots.find((shot) => {
		return frame >= shot.from && frame < shot.from + shot.durationInFrames;
	});
	if (!currentShot) {
		return null;
	}

	const layers = Object.values(
		state?.undoableState.comicEditLayers ?? {},
	).filter((layer) => {
		const sourceItem = layer.sourceItemId
			? state?.undoableState.items[layer.sourceItemId]
			: undefined;
		const layerShotId =
			layer.shotId ??
			(sourceItem?.type === 'image' ? sourceItem.shotId : undefined);
		return layerShotId === currentShot.id && layer.maskAssetId;
	});
	if (layers.length === 0) {
		return (
			<AbsoluteFill
				style={{
					backgroundColor: '#111827',
					color: '#f9fafb',
					fontFamily: 'sans-serif',
					fontSize: 18,
					padding: 18,
				}}
			>
				No mask asset for this shot
			</AbsoluteFill>
		);
	}

	return (
		<AbsoluteFill style={{backgroundColor: '#111827'}}>
			{layers.map((layer) => {
				const maskAsset = layer.maskAssetId ? assets[layer.maskAssetId] : null;
				if (!maskAsset || maskAsset.type !== 'image') {
					return null;
				}

				return (
					<MaskAssetImage
						key={layer.id}
						assetId={maskAsset.id}
						sourceCanvas={layer.sourceCanvas}
						bounds={layer.bounds}
					/>
				);
			})}
			<div
				style={{
					position: 'absolute',
					top: 18,
					left: 18,
					padding: '8px 10px',
					borderRadius: 8,
					backgroundColor: 'rgba(17, 24, 39, 0.88)',
					color: '#ffffff',
					fontFamily: 'sans-serif',
					fontSize: 18,
					fontWeight: 700,
				}}
			>
				Mask · {currentShot.id}
			</div>
		</AbsoluteFill>
	);
};

const overlayStyle: React.CSSProperties = {
	pointerEvents: 'none',
	border: '8px solid rgba(239, 68, 68, 0.88)',
	boxShadow: 'inset 0 0 0 9999px rgba(239, 68, 68, 0.12)',
	backgroundImage:
		'repeating-linear-gradient(135deg, rgba(239, 68, 68, 0.18) 0 12px, rgba(250, 204, 21, 0.18) 12px 24px)',
};

const labelStyle: React.CSSProperties = {
	position: 'absolute',
	top: 18,
	left: 18,
	padding: '8px 10px',
	borderRadius: 8,
	backgroundColor: 'rgba(127, 29, 29, 0.92)',
	color: '#ffffff',
	fontFamily: 'sans-serif',
	fontSize: 22,
	fontWeight: 700,
};

export const AlphaHoleOverlay: React.FC<{
	shots: readonly Shot[];
}> = ({shots}) => {
	const {mode} = useQualityPreview();
	const frame = useCurrentFrame();
	if (mode !== 'alpha-holes') {
		return null;
	}

	const currentShot = shots.find((shot) => {
		return frame >= shot.from && frame < shot.from + shot.durationInFrames;
	});
	if (!currentShot) {
		return null;
	}

	const alphaHoleRatio = diagnosticValue(currentShot, 'alphaHoleRatio:');
	if (alphaHoleRatio === null || alphaHoleRatio <= 0.005) {
		return null;
	}

	return (
		<AbsoluteFill style={overlayStyle}>
			<div style={labelStyle}>
				Alpha hole risk · {currentShot.id} · {alphaHoleRatio}
			</div>
		</AbsoluteFill>
	);
};
