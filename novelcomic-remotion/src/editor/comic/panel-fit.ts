export const BLURRED_BACKGROUND_CONTAIN = 'blurred-background-contain' as const;
export const CONTAIN_BLUR_VERSION = 'contain-blur-v1';
export const PANEL_BLUR_RADIUS_PX = 28;
export const PANEL_DIM_OPACITY = 0.45;

export type PanelFitPolicy = typeof BLURRED_BACKGROUND_CONTAIN;

export const panelFitIds = (
	shotId: string,
): {
	assetId: string;
	foregroundItemId: string;
	backgroundItemId: string;
	foregroundTrackId: string;
	backgroundTrackId: string;
} => {
	return {
		assetId: `asset:${shotId}:panel`,
		foregroundItemId: `item:${shotId}:panel-foreground`,
		backgroundItemId: `item:${shotId}:panel-background`,
		foregroundTrackId: `track:${shotId}:panel-foreground`,
		backgroundTrackId: `track:${shotId}:panel-background`,
	};
};
