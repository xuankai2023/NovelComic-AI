'use client';

import React from 'react';
import {getBrushToolSettings, subscribeBrushToolSettings} from '../tools/brush/brush-settings';
import {
	GRADIENT_SHAPES,
	GRADIENT_STYLES,
	getGradientEdit,
	getGradientPending,
	getGradientSettings,
	gradientColorStops,
	gradientStatusHint,
	setGradientReverse,
	setGradientShape,
	setGradientStyle,
	subscribeGradientSettings,
	updateGradientSettings,
	type GradientShape,
	type GradientStyle,
} from '../tools/gradient/gradient-settings';

const SHAPE_LABELS: Record<GradientShape, string> = {linear: '线性', radial: '径向'};
const STYLE_LABELS: Record<GradientStyle, string> = {
	'foreground-to-background': '前景到背景',
	'foreground-to-transparent': '前景到透明',
};

const numberValue = (value: string, fallback: number) => {
	const next = Number(value);
	return Number.isFinite(next) ? next : fallback;
};

const cssColor = (color: {r: number; g: number; b: number; a: number}) =>
	`rgba(${color.r}, ${color.g}, ${color.b}, ${color.a / 255})`;

/** Current stops over a checkerboard, so a clear end reads as clear. */
const GradientSwatch: React.FC<{from: string; to: string}> = ({from, to}) => (
	<span
		aria-hidden="true"
		className="inline-block h-[18px] w-14 shrink-0 rounded-[3px] border border-black/50"
		style={{
			backgroundColor: '#fff',
			backgroundImage: `linear-gradient(to right, ${from}, ${to}), linear-gradient(45deg, rgba(128,128,128,.45) 25%, transparent 25%), linear-gradient(-45deg, rgba(128,128,128,.45) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(128,128,128,.45) 75%), linear-gradient(-45deg, transparent 75%, rgba(128,128,128,.45) 75%)`,
			backgroundPosition: '0 0, 0 0, 0 2px, 2px -2px, -2px 0',
			backgroundSize: '100% 100%, 4px 4px, 4px 4px, 4px 4px, 4px 4px',
			backgroundRepeat: 'no-repeat, repeat, repeat, repeat, repeat',
		}}
	/>
);

/** Shape, stops, reverse and opacity. The ramp itself is the drag on the canvas. */
export const GradientOptions: React.FC = () => {
	const settings = React.useSyncExternalStore(subscribeGradientSettings, getGradientSettings, getGradientSettings);
	const pending = React.useSyncExternalStore(subscribeGradientSettings, getGradientPending, getGradientPending);
	const brush = React.useSyncExternalStore(subscribeBrushToolSettings, getBrushToolSettings, getBrushToolSettings);
	const stops = gradientColorStops(brush.foreground, brush.background);
	return (
		<>
			<div className="flex overflow-hidden rounded border border-white/15" role="group" aria-label="渐变形状" data-testid="gradientShape">
				{GRADIENT_SHAPES.map((shape) => (
					<button
						key={shape}
						type="button"
						aria-pressed={settings.shape === shape}
						title="线性沿这条线，径向从起点散开。Tab 切换"
						className="px-2 py-1 text-[11px] aria-pressed:bg-white/15"
						onClick={() => setGradientShape(shape)}
					>
						{SHAPE_LABELS[shape]}
					</button>
				))}
			</div>
			<GradientSwatch from={cssColor(stops.from)} to={cssColor(stops.to)} />
			<div className="flex overflow-hidden rounded border border-white/15" role="group" aria-label="渐变类型">
				{GRADIENT_STYLES.map((style) => (
					<button
						key={style}
						type="button"
						aria-pressed={settings.style === style}
						className="px-2 py-1 text-[11px] aria-pressed:bg-white/15"
						onClick={() => setGradientStyle(style)}
					>
						{STYLE_LABELS[style]}
					</button>
				))}
			</div>
			<button
				type="button"
				aria-pressed={settings.reverse}
				className="rounded border border-white/15 px-2 py-1 text-[11px] aria-pressed:bg-white/15"
				onClick={() => setGradientReverse(!settings.reverse)}
			>
				反向
			</button>
			<label className="flex items-center gap-1.5" title="1–9 是 10%–90%，0 是 100%。连续按两位数字可输入精确值">
				Opacity
				<input
					className="h-6 w-24 accent-white/70"
					type="range"
					min={1}
					max={100}
					aria-label="渐变不透明度"
					value={Math.round(settings.opacity * 100)}
					onChange={(event) => updateGradientSettings({opacity: numberValue(event.target.value, settings.opacity * 100) / 100})}
				/>
				<input
					className="h-6 w-14 rounded border border-white/10 bg-black/20 px-1.5 text-[11px]"
					type="number"
					min={1}
					max={100}
					value={Math.round(settings.opacity * 100)}
					onChange={(event) => updateGradientSettings({opacity: numberValue(event.target.value, settings.opacity * 100) / 100})}
				/>
			</label>
			{settings.error ? <span className="text-[#ffb4b4]">{settings.error}</span> : null}
			{pending ? (
				<div className="ml-auto flex items-center gap-2">
					<button
						type="button"
						className="rounded border border-white/15 px-2 py-1 text-[11px]"
						onClick={() => getGradientEdit()?.cancel()}
					>
						取消
					</button>
					<button
						type="button"
						className="rounded border border-white/15 bg-white/15 px-2 py-1 text-[11px] text-white"
						onClick={() => getGradientEdit()?.commit()}
					>
						应用
					</button>
				</div>
			) : null}
			<span className="sr-only">{gradientStatusHint()}</span>
		</>
	);
};
