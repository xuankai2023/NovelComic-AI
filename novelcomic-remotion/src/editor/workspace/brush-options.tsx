'use client';

import React from 'react';
import {
	brushStatusHint,
	colorToHex,
	getBrushToolSettings,
	healingStatusHint,
	hexToColor,
	setBrushForeground,
	setBrushMode,
	setHealingMode,
	SPOT_HEALING_MODE_LABELS,
	SPOT_HEALING_MODES,
	subscribeBrushToolSettings,
	updateBrushToolSettings,
	type BrushMode,
} from '../tools/brush/brush-settings';
import {cloneStatusHint, getCloneSettings, setCloneAligned, setCloneSampleAll, subscribeCloneSettings} from '../tools/brush/clone-stamp';

const modes: Array<{id: BrushMode; label: string}> = [
	{id: 'paint', label: '绘画'},
	{id: 'erase', label: '擦除'},
];

const numberValue = (value: string, fallback: number) => {
	const next = Number(value);
	return Number.isFinite(next) ? next : fallback;
};

/** Size, hardness, opacity and smoothing, matching Compositor's BrushControls. */
export const BrushOptions: React.FC = () => <BrushFamilyOptions kind="brush" />;

/** Spot Healing shares the brush tip and adds the Content-Aware / texture / proximity type. */
export const HealingOptions: React.FC = () => <BrushFamilyOptions kind="healing" />;

/** Clone Stamp keeps its own soft tip, plus Aligned and Sample. */
export const CloneOptions: React.FC = () => <BrushFamilyOptions kind="clone" />;

const BrushFamilyOptions: React.FC<{kind: 'brush' | 'healing' | 'clone'}> = ({kind}) => {
	const settings = React.useSyncExternalStore(subscribeBrushToolSettings, getBrushToolSettings, getBrushToolSettings);
	const clone = React.useSyncExternalStore(subscribeCloneSettings, getCloneSettings, getCloneSettings);
	const foreground = React.useRef<HTMLInputElement>(null);
	return (
		<>
			{kind === 'clone' ? (
				<>
					<button
						type="button"
						aria-pressed={clone.aligned}
						data-testid="cloneAligned"
						title="源点跟着笔刷走，笔画之间保持同一偏移；关闭后每一笔都从源点重新开始"
						className="rounded border border-white/15 px-2 py-1 text-[11px] aria-pressed:bg-white/15"
						onClick={() => setCloneAligned(!clone.aligned)}
					>
						对齐
					</button>
					<div className="flex overflow-hidden rounded border border-white/15" role="group" aria-label="取样" data-testid="cloneSample">
						<button
							type="button"
							aria-pressed={!clone.sampleAllLayers}
							title="只复制当前图层。Tab 切换取样"
							className="px-2 py-1 text-[11px] aria-pressed:bg-white/15"
							onClick={() => setCloneSampleAll(false)}
						>
							当前图层
						</button>
						<button
							type="button"
							aria-pressed={clone.sampleAllLayers}
							title="按画面上的样子复制所有可见图层。Tab 切换取样"
							className="px-2 py-1 text-[11px] aria-pressed:bg-white/15"
							onClick={() => setCloneSampleAll(true)}
						>
							所有图层
						</button>
					</div>
				</>
			) : kind === 'healing' ? (
				<div className="flex overflow-hidden rounded border border-white/15" role="group" aria-label="修复类型" data-testid="spotHealingType">
					{SPOT_HEALING_MODES.map((mode) => (
						<button
							key={mode}
							type="button"
							aria-pressed={settings.healingMode === mode}
							title="Tab 切换修复类型"
							className="px-2 py-1 text-[11px] aria-pressed:bg-white/15"
							onClick={() => setHealingMode(mode)}
						>
							{SPOT_HEALING_MODE_LABELS[mode]}
						</button>
					))}
				</div>
			) : (
				<div className="flex overflow-hidden rounded border border-white/15" role="group" aria-label="画笔模式">
					{modes.map((mode) => (
						<button
							key={mode.id}
							type="button"
							aria-pressed={settings.mode === mode.id}
							title="B 绘画，E 擦除，Tab 切换"
							className="px-2 py-1 text-[11px] aria-pressed:bg-white/15"
							onClick={() => setBrushMode(mode.id)}
						>
							{mode.label}
						</button>
					))}
				</div>
			)}
			<label className="flex items-center gap-1.5">
				Size
				<input
					className="h-6 w-16 rounded border border-white/10 bg-black/20 px-1.5 text-[11px]"
					type="number"
					min={1}
					max={2000}
					aria-label="画笔大小"
					value={settings.diameter}
					onChange={(event) => updateBrushToolSettings({diameter: numberValue(event.target.value, settings.diameter)})}
				/>
			</label>
			<label className="flex items-center gap-1.5" title="0% 是最软的边缘，100% 是硬边">
				Hardness
				<input
					className="h-6 w-24 accent-white/70"
					type="range"
					min={0}
					max={100}
					aria-label="画笔硬度"
					value={Math.round(settings.hardness * 100)}
					onChange={(event) => updateBrushToolSettings({hardness: numberValue(event.target.value, settings.hardness * 100) / 100})}
				/>
				<input
					className="h-6 w-14 rounded border border-white/10 bg-black/20 px-1.5 text-[11px]"
					type="number"
					min={0}
					max={100}
					value={Math.round(settings.hardness * 100)}
					onChange={(event) => updateBrushToolSettings({hardness: numberValue(event.target.value, settings.hardness * 100) / 100})}
				/>
			</label>
			<label className="flex items-center gap-1.5" title="1–9 是 10%–90%，0 是 100%。连续按两位数字可输入精确值">
				Opacity
				<input
					className="h-6 w-24 accent-white/70"
					type="range"
					min={1}
					max={100}
					aria-label="画笔不透明度"
					value={Math.round(settings.opacity * 100)}
					onChange={(event) => updateBrushToolSettings({opacity: numberValue(event.target.value, settings.opacity * 100) / 100})}
				/>
				<input
					className="h-6 w-14 rounded border border-white/10 bg-black/20 px-1.5 text-[11px]"
					type="number"
					min={1}
					max={100}
					value={Math.round(settings.opacity * 100)}
					onChange={(event) => updateBrushToolSettings({opacity: numberValue(event.target.value, settings.opacity * 100) / 100})}
				/>
			</label>
			{kind === 'brush' ? (
				<label className="flex items-center gap-1.5" title="画笔拖着一根这么长的线跟着光标，手抖时笔画仍然平滑">
					Smoothing
					<input
						className="h-6 w-24 accent-white/70"
						type="range"
						min={0}
						max={100}
						aria-label="画笔平滑"
						value={settings.smoothing}
						onChange={(event) => updateBrushToolSettings({smoothing: numberValue(event.target.value, settings.smoothing)})}
					/>
					<input
						className="h-6 w-14 rounded border border-white/10 bg-black/20 px-1.5 text-[11px]"
						type="number"
						min={0}
						max={100}
						value={settings.smoothing}
						onChange={(event) => updateBrushToolSettings({smoothing: numberValue(event.target.value, settings.smoothing)})}
					/>
				</label>
			) : null}
			{kind === 'clone' ? null : (
				<label className="flex items-center gap-1.5">
					Color
					<button
						type="button"
						className="h-[18px] w-[34px] rounded border border-black shadow-[inset_0_0_0_1px_white]"
						style={{backgroundColor: colorToHex(settings.foreground)}}
						aria-label="前景色"
						title="前景色"
						onClick={() => foreground.current?.click()}
					/>
					<input
						ref={foreground}
						className="sr-only"
						type="color"
						aria-label="选择前景色"
						value={colorToHex(settings.foreground)}
						onChange={(event) => {
							const next = hexToColor(event.target.value);
							if (next) setBrushForeground(next);
						}}
					/>
				</label>
			)}
			{kind === 'clone' && settings.error ? <span className="text-[#ffb4b4]">{settings.error}</span> : null}
			{kind === 'clone' && !clone.source && !settings.error ? <span className="text-white/45">按住 Option 点击以设定源点</span> : null}
			<span className="sr-only">
				{kind === 'healing' ? healingStatusHint() : kind === 'clone' ? cloneStatusHint() : brushStatusHint(settings.mode)}
			</span>
		</>
	);
};
