'use client';

import {
	Bandage,
	Blend,
	Droplet,
	Eraser,
	Hand,
	Lasso,
	MoveDiagonal2,
	Paintbrush,
	Pipette,
	Shapes,
	CircleDashed,
	SquareDashed,
	Type,
	WandSparkles,
	ZoomIn,
} from 'lucide-react';
import React from 'react';
import {
	getLassoToolSettings,
	subscribeLassoToolSettings,
} from '../tools/lasso/lasso-settings';
import {
	getMarqueeToolSettings,
	subscribeMarqueeToolSettings,
} from '../tools/marquee/marquee-settings';
import {
	colorToHex,
	getBrushToolSettings,
	hexToColor,
	setBrushBackground,
	setBrushForeground,
	subscribeBrushToolSettings,
} from '../tools/brush/brush-settings';
import {TOOL_REGISTRY} from '../tools/tool-registry';
import {useDocumentWorkspace} from './document-workspace-context';

// Compositor keeps mode variants in the options bar instead of expanding each
// one into a separate rail button. Keep the complete registry for shortcuts and
// sessions, but render the same compact set of primary tools in the rail.
const COMPOSITOR_RAIL_TOOL_IDS = [
	'move',
	'marquee-rectangle',
	'lasso',
	'magic-wand',
	'brush',
	'healing',
	'clone-stamp',
	'blur',
	'gradient',
	'eyedropper',
	'shape',
	'type',
	'hand',
	'zoom',
] as const;

const RAIL_TOOLS = COMPOSITOR_RAIL_TOOL_IDS.map((id) => {
	const definition = TOOL_REGISTRY.find((candidate) => candidate.id === id);
	if (!definition) throw new Error(`工具栏缺少工具定义: ${id}`);
	return {...definition, id};
});

/** Rubber stamp from Compositor's CloneStampToolIcon: handle, neck, body, and pad. */
const CloneStampToolIcon: React.FC<{className?: string}> = ({className}) => (
	<svg viewBox="0 0 18 18" className={className} aria-hidden="true">
		<g fill="currentColor">
			<ellipse cx="9" cy="3.06" rx="3.06" ry="2.7" />
			<rect x="7.74" y="5.04" width="2.52" height="5.04" />
			<rect x="2.16" y="9.72" width="13.68" height="3.96" rx="1.44" />
			<rect x="1.08" y="14.76" width="15.84" height="2.16" />
		</g>
	</svg>
);

const COMPOSITOR_RAIL_ICONS = {
	move: MoveDiagonal2,
	'marquee-rectangle': SquareDashed,
	lasso: Lasso,
	'magic-wand': WandSparkles,
	brush: Paintbrush,
	healing: Bandage,
	'clone-stamp': CloneStampToolIcon,
	blur: Droplet,
	gradient: Blend,
	eyedropper: Pipette,
	shape: Shapes,
	type: Type,
	hand: Hand,
	zoom: ZoomIn,
} as const;

/** Straight-segment lasso, matching Compositor's PolygonalLassoToolIcon on its 18-unit grid. */
const PolygonalLassoIcon: React.FC<{className?: string}> = ({className}) => (
	<svg viewBox="0 0 18 18" className={className} aria-hidden="true">
		<g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
			<path d="M1.2 7 L4 2.4 L11.8 1.8 L16.8 5.2 L15.6 10.4 L7 11.6 Z" />
			<path d="M8.9 10.9 L13.3 10.5 L11.6 14.5 Z" />
			<path d="M11.6 14.5 L12.9 17.3" />
		</g>
	</svg>
);

export const ToolBar: React.FC = () => {
	const {tool, setTool} = useDocumentWorkspace();
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
	const foregroundInput = React.useRef<HTMLInputElement>(null);
	const backgroundInput = React.useRef<HTMLInputElement>(null);
	return (
		<aside
			className="flex min-h-0 w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-white/8 bg-[#15161a] py-2"
			aria-label="工具栏"
			data-testid="tool-bar"
		>
			{RAIL_TOOLS.map(({id, label, shortcut}) => {
				const ellipse = id === 'marquee-rectangle' && marqueeKind === 'ellipse';
				const polygonal = id === 'lasso' && lassoKind === 'polygonal';
				const erasing = id === 'brush' && brush.mode === 'erase';
				const Icon = ellipse ? CircleDashed : erasing ? Eraser : COMPOSITOR_RAIL_ICONS[id];
				const name = id === 'marquee-rectangle' ? '选框' : label;
				const hint = erasing
					? '橡皮擦 (E)，B 回到绘画'
					: id === 'clone-stamp'
						? '仿制图章 (S) · Option 点击设定源点'
						: `${name}${shortcut ? ` (${shortcut})` : ''}`;
				const active = tool === id || (id === 'lasso' && tool === 'polygon-lasso');
				return (
					<button
						key={id}
						type="button"
						data-active={active}
						aria-label={hint}
						title={hint}
						onClick={() => setTool(id)}
						className="group relative flex size-9 items-center justify-center rounded-[7px] text-white/72 transition-colors hover:bg-white/8 hover:text-white data-[active=true]:bg-white/12 data-[active=true]:text-white data-[active=true]:shadow-[inset_0_0_0_1px_rgba(255,255,255,.14)]"
					>
						{polygonal ? (
							<PolygonalLassoIcon className="size-[18px]" />
						) : (
							<Icon className={id === 'clone-stamp' ? 'size-[18px]' : 'size-[17px]'} />
						)}
					</button>
				);
			})}
			<div className="relative mt-2 h-9 w-9 shrink-0" aria-label="前景色和背景色" title="X 交换前景色和背景色，D 恢复黑白">
				<button
					type="button"
					className="absolute right-0 bottom-0 size-6 rounded-md border border-black shadow-[inset_0_0_0_1.5px_white]"
					style={{backgroundColor: colorToHex(brush.background)}}
					aria-label="背景色"
					onClick={() => backgroundInput.current?.click()}
				/>
				<button
					type="button"
					className="absolute top-0 left-0 size-6 rounded-md border border-black shadow-[inset_0_0_0_1.5px_white]"
					style={{backgroundColor: colorToHex(brush.foreground)}}
					aria-label="前景色"
					onClick={() => foregroundInput.current?.click()}
				/>
				<input
					ref={backgroundInput}
					className="sr-only"
					type="color"
					tabIndex={-1}
					aria-label="选择背景色"
					value={colorToHex(brush.background)}
					onChange={(event) => {
						const next = hexToColor(event.target.value);
						if (next) setBrushBackground(next);
					}}
				/>
				<input
					ref={foregroundInput}
					className="sr-only"
					type="color"
					tabIndex={-1}
					aria-label="选择前景色"
					value={colorToHex(brush.foreground)}
					onChange={(event) => {
						const next = hexToColor(event.target.value);
						if (next) setBrushForeground(next);
					}}
				/>
			</div>
		</aside>
	);
};
