'use client';

import React from 'react';
import {colorToHex, getBrushToolSettings, hexToColor, setBrushForeground, subscribeBrushToolSettings} from '../tools/brush/brush-settings';
import {
	SHAPE_KINDS,
	getShapeSettings,
	setShapeCornerRadius,
	setShapeKind,
	setShapeLineWidth,
	shapeStatusHint,
	subscribeShapeSettings,
	type ShapeKind,
} from '../tools/shape/shape-settings';

const KIND_LABELS: Record<ShapeKind, string> = {
	rectangle: '矩形',
	ellipse: '椭圆',
	line: '直线',
};

const numberValue = (value: string, fallback: number) => {
	const next = Number(value);
	return Number.isFinite(next) ? next : fallback;
};

/** Kind, line width, corner radius, and the foreground fill. The drag itself is on the canvas. */
export const ShapeOptions: React.FC = () => {
	const settings = React.useSyncExternalStore(subscribeShapeSettings, getShapeSettings, getShapeSettings);
	const brush = React.useSyncExternalStore(subscribeBrushToolSettings, getBrushToolSettings, getBrushToolSettings);
	const fill = React.useRef<HTMLInputElement>(null);
	return (
		<>
			<div className="flex overflow-hidden rounded border border-white/15" role="group" aria-label="形状" data-testid="shapeKind" title="Shift-U（或 Tab）在矩形、椭圆和直线之间切换">
				{SHAPE_KINDS.map((kind) => (
					<button
						key={kind}
						type="button"
						aria-pressed={settings.kind === kind}
						className="px-2 py-1 text-[11px] aria-pressed:bg-white/15"
						onClick={() => setShapeKind(kind)}
					>
						{KIND_LABELS[kind]}
					</button>
				))}
			</div>
			{settings.kind === 'line' ? (
				<label className="flex items-center gap-1.5">
					Width
					<input
						className="h-6 w-24 accent-white/70"
						type="range"
						min={1}
						max={100}
						aria-label="线宽"
						value={Math.min(100, settings.lineWidth)}
						onChange={(event) => setShapeLineWidth(numberValue(event.target.value, settings.lineWidth))}
					/>
					<input
						className="h-6 w-14 rounded border border-white/10 bg-black/20 px-1.5 text-right text-[11px]"
						type="number"
						min={1}
						max={5000}
						aria-label="线宽像素"
						value={settings.lineWidth}
						onChange={(event) => setShapeLineWidth(numberValue(event.target.value, settings.lineWidth))}
					/>
					<span>px</span>
				</label>
			) : null}
			{settings.kind === 'rectangle' ? (
				<label className="flex items-center gap-1.5" title="圆角像素；0 为直角">
					Radius
					<input
						className="h-6 w-24 accent-white/70"
						type="range"
						min={0}
						max={200}
						aria-label="圆角"
						value={Math.min(200, settings.cornerRadius)}
						onChange={(event) => setShapeCornerRadius(numberValue(event.target.value, settings.cornerRadius))}
					/>
					<input
						className="h-6 w-14 rounded border border-white/10 bg-black/20 px-1.5 text-right text-[11px]"
						type="number"
						min={0}
						max={5000}
						aria-label="圆角像素"
						value={settings.cornerRadius}
						onChange={(event) => setShapeCornerRadius(numberValue(event.target.value, settings.cornerRadius))}
					/>
					<span>px</span>
				</label>
			) : null}
			<label className="flex items-center gap-1.5">
				Fill
				<button
					type="button"
					className="h-[18px] w-9 rounded-[3px] border border-black/50"
					style={{backgroundColor: colorToHex(brush.foreground)}}
					aria-label="形状填充色"
					title="形状使用前景色填充，点击更换"
					onClick={() => fill.current?.click()}
				/>
				<input
					ref={fill}
					className="sr-only"
					type="color"
					aria-label="选择形状填充色"
					value={colorToHex(brush.foreground)}
					onChange={(event) => {
						const next = hexToColor(event.target.value);
						if (next) setBrushForeground(next);
					}}
				/>
			</label>
			{settings.error ? <span className="text-[#ffb4b4]">{settings.error}</span> : null}
			<span className="sr-only">{shapeStatusHint(settings.kind)}</span>
		</>
	);
};
