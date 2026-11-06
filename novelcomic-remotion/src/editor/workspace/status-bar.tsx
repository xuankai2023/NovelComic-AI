'use client';

import React from 'react';
import {cloneStatusHint} from '../tools/brush/clone-stamp';
import {
	brushStatusHint,
	getBrushToolSettings,
	healingStatusHint,
	subscribeBrushToolSettings,
} from '../tools/brush/brush-settings';
import {
	getLassoToolSettings,
	lassoStatusHint,
	subscribeLassoToolSettings,
} from '../tools/lasso/lasso-settings';
import {
	getMarqueeToolSettings,
	marqueeStatusHint,
	subscribeMarqueeToolSettings,
} from '../tools/marquee/marquee-settings';
import {getToolDefinition} from '../tools/tool-registry';
import {ViewportStore, useViewportSnapshot} from '../viewport/viewport-store';
import {useDocumentWorkspace} from './document-workspace-context';

export const StatusBar: React.FC<{viewportStore: ViewportStore}> = ({viewportStore}) => {
	const {document, tool} = useDocumentWorkspace();
	const {transform} = useViewportSnapshot(viewportStore);
	const marqueeKind = React.useSyncExternalStore(
		subscribeMarqueeToolSettings,
		() => getMarqueeToolSettings().kind,
		() => getMarqueeToolSettings().kind,
	);
	const lassoKind = React.useSyncExternalStore(
		subscribeLassoToolSettings,
		() => getLassoToolSettings().kind,
		() => getLassoToolSettings().kind,
	);
	const brush = React.useSyncExternalStore(subscribeBrushToolSettings, getBrushToolSettings, getBrushToolSettings);
	const hint =
		tool === 'brush'
			? (brush.error ?? brushStatusHint(brush.mode))
			: tool === 'healing'
				? (brush.error ?? healingStatusHint())
				: tool === 'clone-stamp'
					? (brush.error ?? cloneStatusHint())
					: tool === 'marquee-rectangle' || tool === 'marquee-ellipse'
				? marqueeStatusHint(marqueeKind)
				: tool === 'lasso' || tool === 'polygon-lasso'
					? lassoStatusHint(lassoKind)
					: getToolDefinition(tool).statusHint;
	return (
		<footer
			className="flex h-[30px] shrink-0 items-center gap-4 border-t border-white/8 bg-[#171717] px-[18px] font-mono text-[11px] text-white/42 tabular-nums"
			aria-label="状态栏"
			data-testid="status-bar"
		>
			<span className="w-[62px] shrink-0 text-left">{Math.round(transform.zoom * 100)}%</span>
			<span>
				{document.width} × {document.height} px
			</span>
			<span>sRGB · Transparent</span>
			<div className="flex-1" />
			<span className="min-w-0 truncate font-sans">{hint}</span>
		</footer>
	);
};
