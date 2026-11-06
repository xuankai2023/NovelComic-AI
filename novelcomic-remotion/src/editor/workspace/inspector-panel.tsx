'use client';

import {Eye, EyeOff, Lock, RotateCcw, Unlock} from 'lucide-react';
import React from 'react';
import type {
	AdjustmentContent,
	BlendMode,
	DocumentColor,
	LayerEffectKind,
	LayerNode,
} from '../document/types';
import {BLEND_MODES} from '../document/types';
import {createDefaultCameraRawSettings, type CameraRawSettings} from '../document/camera-raw';
import {
	applyMaskToRasterAsset,
	createMaskAsset,
	loadMaskSurface,
} from '../pixels/mask-assets';
import {MaskPixelClient} from '../pixels/mask-pixel-client';
import {useDocumentWorkspace} from './document-workspace-context';

const inputClass =
	'h-7 w-full min-w-0 rounded border border-white/10 bg-black/20 px-2 text-xs text-white outline-none focus:border-blue-400/70';
const number = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) ? value : 0;
const hex = (color: DocumentColor) =>
	`#${[color.r, color.g, color.b]
		.map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
		.join('')}`;
const fromHex = (value: string, alpha = 1): DocumentColor => ({
	r: Number.parseInt(value.slice(1, 3), 16),
	g: Number.parseInt(value.slice(3, 5), 16),
	b: Number.parseInt(value.slice(5, 7), 16),
	a: alpha,
});

const Field: React.FC<{
	label: string;
	value: number;
	step?: number;
	onChange: (value: number) => void;
}> = ({label, value, step = 1, onChange}) => (
	<label className="grid grid-cols-[46px_1fr] items-center gap-2 text-[10px] text-white/55">
		<span>{label}</span>
		<input
			className={inputClass}
			type="number"
			step={step}
			value={value}
			onChange={(event) => onChange(Number(event.target.value))}
		/>
	</label>
);

const ColorField: React.FC<{
	label: string;
	value: DocumentColor;
	onChange: (value: DocumentColor) => void;
}> = ({label, value, onChange}) => (
	<label className="grid grid-cols-[46px_1fr] items-center gap-2 text-[10px] text-white/55">
		<span>{label}</span>
		<input
			className={`${inputClass} p-0.5`}
			type="color"
			value={hex(value)}
			onChange={(event) => onChange(fromHex(event.target.value, value.a))}
		/>
	</label>
);

const ToggleField: React.FC<{
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}> = ({label, checked, onChange}) => (
	<label className="flex items-center justify-between text-[10px] text-white/55">
		<span>{label}</span>
		<input
			type="checkbox"
			checked={checked}
			onChange={(event) => onChange(event.target.checked)}
		/>
	</label>
);

const Section: React.FC<{title: string; children: React.ReactNode}> = ({
	title,
	children,
}) => (
	<section className="border-b border-white/8 p-3">
		<h3 className="mb-2 text-[10px] font-semibold tracking-[0.08em] text-white/45 uppercase">
			{title}
		</h3>
		{children}
	</section>
);

const EFFECT_LABELS: Record<LayerEffectKind, string> = {
	stroke: '描边',
	dropShadow: '投影',
	colorOverlay: '颜色叠加',
	innerShadow: '内阴影',
	outerGlow: '外发光',
	innerGlow: '内发光',
};
const effectDefaults = (effect: LayerEffectKind) => {
	const color = {r: 0, g: 0, b: 0, a: 1};
	if (effect === 'stroke') return {enabled: true, color, size: 2, position: 'outside' as const, opacity: 1};
	if (effect === 'colorOverlay') return {enabled: true, color, opacity: 1, blendMode: 'normal' as const};
	if (effect === 'outerGlow' || effect === 'innerGlow') return {enabled: true, color: {r: 255, g: 255, b: 255, a: 1}, opacity: 0.75, size: 12, spread: 0};
	return {enabled: true, color, opacity: 0.75, angle: 120, distance: 8, size: 12, spread: 0};
};
const defaultAdjustment = (kind: AdjustmentContent['kind']): AdjustmentContent => {
	switch (kind) {
		case 'hue-saturation': return {kind, hue: 0, saturation: 0, lightness: 0, colorize: false};
		case 'levels': return {kind, channels: [{inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255}]};
		case 'curves': return {kind, channels: [{channel: 'rgb', points: [{x: 0, y: 0}, {x: 1, y: 1}]}]};
		case 'exposure': return {kind, exposure: 0, offset: 0, gamma: 1};
		case 'gradient-map': return {kind, shadows: {r: 0, g: 0, b: 0, a: 1}, highlights: {r: 255, g: 255, b: 255, a: 1}, reversed: false};
		case 'grain': return {kind, amount: 0, monochromatic: true, seed: 1};
		case 'invert': return {kind};
		case 'black-white': return {kind, settings: {reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80}};
		case 'color-balance': return {kind, settings: {shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true}};
		case 'gaussian-blur': return {kind, radius: 0};
		case 'motion-blur': return {kind, angle: 0, distance: 0};
		case 'add-noise': return {kind, amount: 0, gaussian: true, monochromatic: false, seed: 1};
		case 'camera-raw': return {kind, settings: createDefaultCameraRawSettings()};
	}
	throw new Error(`Unsupported adjustment kind: ${kind}`);
};

const AdjustmentFields: React.FC<{
	content: AdjustmentContent;
	onChange: (content: AdjustmentContent, field: string) => void;
}> = ({content, onChange}) => {
	if (content.kind === 'hue-saturation')
		return <>
			<Field label="色相" value={content.hue} onChange={(hue) => onChange({...content, hue}, 'hue')} />
			<Field label="饱和度" value={content.saturation} onChange={(saturation) => onChange({...content, saturation}, 'saturation')} />
			<Field label="明度" value={content.lightness} onChange={(lightness) => onChange({...content, lightness}, 'lightness')} />
			<ToggleField label="着色" checked={content.colorize} onChange={(colorize) => onChange({...content, colorize}, 'colorize')} />
		</>;
	if (content.kind === 'levels') {
		const channel = content.channels[0] ?? {inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 0, outputWhite: 255};
		const set = (changes: Partial<typeof channel>, field: string) => onChange({...content, channels: [{...channel, ...changes}, ...content.channels.slice(1)]}, field);
		return <>
			<Field label="输入黑" value={channel.inputBlack} onChange={(inputBlack) => set({inputBlack}, 'inputBlack')} />
			<Field label="输入白" value={channel.inputWhite} onChange={(inputWhite) => set({inputWhite}, 'inputWhite')} />
			<Field label="Gamma" value={channel.gamma} step={0.05} onChange={(gamma) => set({gamma: Math.max(0.01, gamma)}, 'gamma')} />
			<Field label="输出黑" value={channel.outputBlack} onChange={(outputBlack) => set({outputBlack}, 'outputBlack')} />
			<Field label="输出白" value={channel.outputWhite} onChange={(outputWhite) => set({outputWhite}, 'outputWhite')} />
		</>;
	}
	if (content.kind === 'curves') {
		const channel = content.channels[0] ?? {channel: 'rgb' as const, points: [{x: 0, y: 0}, {x: 1, y: 1}]};
		const first = channel.points[0] ?? {x: 0, y: 0};
		const last = channel.points.at(-1) ?? {x: 1, y: 1};
		const setPoint = (index: number, changes: Partial<typeof first>, field: string) => {
			const points = channel.points.length >= 2 ? channel.points.slice() : [first, last];
			points[index] = {...points[index]!, ...changes};
			onChange({...content, channels: [{...channel, points}, ...content.channels.slice(1)]}, field);
		};
		return <>
			<Field label="黑点 X" value={first.x} step={0.01} onChange={(x) => setPoint(0, {x}, 'black-x')} />
			<Field label="黑点 Y" value={first.y} step={0.01} onChange={(y) => setPoint(0, {y}, 'black-y')} />
			<Field label="白点 X" value={last.x} step={0.01} onChange={(x) => setPoint(channel.points.length > 1 ? channel.points.length - 1 : 1, {x}, 'white-x')} />
			<Field label="白点 Y" value={last.y} step={0.01} onChange={(y) => setPoint(channel.points.length > 1 ? channel.points.length - 1 : 1, {y}, 'white-y')} />
		</>;
	}
	if (content.kind === 'exposure') return <>
		<Field label="曝光" value={content.exposure} step={0.1} onChange={(exposure) => onChange({...content, exposure}, 'exposure')} />
		<Field label="偏移" value={content.offset} step={0.01} onChange={(offset) => onChange({...content, offset}, 'offset')} />
		<Field label="Gamma" value={content.gamma} step={0.05} onChange={(gamma) => onChange({...content, gamma: Math.max(0.01, gamma)}, 'gamma')} />
	</>;
	if (content.kind === 'gradient-map') return <>
		<ColorField label="阴影" value={content.shadows} onChange={(shadows) => onChange({...content, shadows}, 'shadows')} />
		<ColorField label="高光" value={content.highlights} onChange={(highlights) => onChange({...content, highlights}, 'highlights')} />
		<ToggleField label="反向" checked={content.reversed} onChange={(reversed) => onChange({...content, reversed}, 'reversed')} />
	</>;
	if (content.kind === 'grain') return <>
		<Field label="数量" value={content.amount} step={0.01} onChange={(amount) => onChange({...content, amount: Math.max(0, amount)}, 'amount')} />
		<Field label="种子" value={content.seed} onChange={(seed) => onChange({...content, seed: Math.round(seed)}, 'seed')} />
		<ToggleField label="单色" checked={content.monochromatic} onChange={(monochromatic) => onChange({...content, monochromatic}, 'monochromatic')} />
	</>;
	if (content.kind === 'black-white') {
		const fields = [['红', 'reds'], ['黄', 'yellows'], ['绿', 'greens'], ['青', 'cyans'], ['蓝', 'blues'], ['洋红', 'magentas']] as const;
		return <>{fields.map(([label, key]) => <Field key={key} label={label} value={content.settings[key]} onChange={(value) => onChange({...content, settings: {...content.settings, [key]: value}}, key)} />)}</>;
	}
	if (content.kind === 'color-balance') {
		const ranges = [['阴影', 'shadows'], ['中间调', 'midtones'], ['高光', 'highlights']] as const;
		return <>{ranges.flatMap(([label, key]) => content.settings[key].map((value, index) => <Field key={`${key}-${index}`} label={`${label}${['青红', '洋绿', '黄蓝'][index]}`} value={value} onChange={(next) => {const tuple = [...content.settings[key]] as [number, number, number]; tuple[index] = next; onChange({...content, settings: {...content.settings, [key]: tuple}}, `${key}-${index}`);}} />))}<ToggleField label="保留明度" checked={content.settings.preserveLuminosity} onChange={(preserveLuminosity) => onChange({...content, settings: {...content.settings, preserveLuminosity}}, 'preserveLuminosity')} /></>;
	}
	if (content.kind === 'gaussian-blur') return <Field label="半径" value={content.radius} onChange={(radius) => onChange({...content, radius: Math.max(0, radius)}, 'radius')} />;
	if (content.kind === 'motion-blur') return <>
		<Field label="角度" value={content.angle} onChange={(angle) => onChange({...content, angle}, 'angle')} />
		<Field label="距离" value={content.distance} onChange={(distance) => onChange({...content, distance: Math.max(0, distance)}, 'distance')} />
	</>;
	if (content.kind === 'add-noise') return <>
		<Field label="数量" value={content.amount} step={0.01} onChange={(amount) => onChange({...content, amount: Math.max(0, amount)}, 'amount')} />
		<Field label="种子" value={content.seed} onChange={(seed) => onChange({...content, seed: Math.round(seed)}, 'seed')} />
		<ToggleField label="高斯" checked={content.gaussian} onChange={(gaussian) => onChange({...content, gaussian}, 'gaussian')} />
		<ToggleField label="单色" checked={content.monochromatic} onChange={(monochromatic) => onChange({...content, monochromatic}, 'monochromatic')} />
	</>;
	if (content.kind === 'camera-raw') {
		const set = (changes: Partial<CameraRawSettings>, field: string) => onChange({...content, settings: {...content.settings, ...changes}}, field);
		return <>
			<Field label="曝光" value={content.settings.exposure} step={0.1} onChange={(exposure) => set({exposure}, 'exposure')} />
			<Field label="对比" value={content.settings.contrast} onChange={(contrast) => set({contrast}, 'contrast')} />
			<Field label="高光" value={content.settings.highlights} onChange={(highlights) => set({highlights}, 'highlights')} />
			<Field label="阴影" value={content.settings.shadows} onChange={(shadows) => set({shadows}, 'shadows')} />
			<Field label="白色色阶" value={content.settings.whites} onChange={(whites) => set({whites}, 'whites')} />
			<Field label="黑色色阶" value={content.settings.blacks} onChange={(blacks) => set({blacks}, 'blacks')} />
			<Field label="色温" value={content.settings.temperature} onChange={(temperature) => set({temperature}, 'temperature')} />
			<Field label="色调" value={content.settings.tint} onChange={(tint) => set({tint}, 'tint')} />
			<Field label="饱和度" value={content.settings.saturation} onChange={(saturation) => set({saturation}, 'saturation')} />
			<Field label="清晰度" value={content.settings.clarity} onChange={(clarity) => set({clarity}, 'clarity')} />
			<Field label="晕影" value={content.settings.vignette.amount} onChange={(amount) => set({vignette: {...content.settings.vignette, amount}}, 'vignette')} />
			<Field label="颗粒" value={content.settings.grain.amount} onChange={(amount) => set({grain: {...content.settings.grain, amount}}, 'grain')} />
			<Field label="曲线阴影" value={content.settings.curve.shadows} onChange={(shadows) => set({curve: {...content.settings.curve, shadows}}, 'curve-shadows')} />
			<Field label="曲线高光" value={content.settings.curve.highlights} onChange={(highlights) => set({curve: {...content.settings.curve, highlights}}, 'curve-highlights')} />
			<Field label="混合色相" value={content.settings.mixer.red.hue} onChange={(hue) => set({mixer: {...content.settings.mixer, red: {...content.settings.mixer.red, hue}}}, 'mixer-hue')} />
			<Field label="分级饱和" value={content.settings.grading.global.saturation} onChange={(saturation) => set({grading: {...content.settings.grading, global: {...content.settings.grading.global, saturation}}}, 'grading-saturation')} />
			<Field label="锐化" value={content.settings.detail.sharpenAmount} onChange={(sharpenAmount) => set({detail: {...content.settings.detail, sharpenAmount}}, 'detail-sharpen')} />
			<Field label="镜头畸变" value={content.settings.optics.distortion} onChange={(distortion) => set({optics: {...content.settings.optics, distortion}}, 'optics-distortion')} />
			<Field label="几何旋转" value={content.settings.geometry.rotate} onChange={(rotate) => set({geometry: {...content.settings.geometry, rotate}}, 'geometry-rotate')} />
			<Field label="辉光" value={content.settings.bloom.amount} onChange={(amount) => set({bloom: {...content.settings.bloom, amount}}, 'bloom')} />
			<ToggleField label="抖动" checked={content.settings.dither.enabled} onChange={(enabled) => set({dither: {...content.settings.dither, enabled}}, 'dither')} />
			{content.settings.dither.enabled ? <Field label="抖动级别" value={content.settings.dither.levels} onChange={(levels) => set({dither: {...content.settings.dither, levels}}, 'dither-levels')} /> : null}
		</>;
	}
	return <div className="text-[10px] text-white/35">此调整层无需额外参数</div>;
};

export const InspectorPanel: React.FC = () => {
	const {document, activeLayerId, selectedLayerIds, dispatch, clearSelection} =
		useDocumentWorkspace();
	const layer = activeLayerId ? document.layers[activeLayerId] : undefined;
	if (!layer)
		return (
			<aside
				className="flex min-h-0 flex-1 flex-col bg-[#17181c] text-white"
				aria-label="属性检查器"
				data-testid="inspector-panel"
			>
				<div className="flex h-11 items-center border-b border-white/8 px-3 text-xs font-semibold">
					属性
				</div>
				<div className="flex flex-1 items-center justify-center px-6 text-center text-xs leading-5 text-white/35">
					选择图层后编辑属性
				</div>
			</aside>
		);

	const update = (changes: Partial<LayerNode>, mergeKey?: string) =>
		dispatch(
			'layer.update',
			{layerId: layer.id, changes},
			mergeKey ? {mergeKey: `layer:${layer.id}:${mergeKey}`} : undefined,
		);
	const updateTransform = <K extends keyof LayerNode['transform']>(
		key: K,
		value: LayerNode['transform'][K],
	) =>
		update(
			{transform: {...layer.transform, [key]: value}},
			`transform:${String(key)}`,
		);
	const updateOpacity = (value: number) =>
		update({opacity: Math.max(0, Math.min(1, value))}, 'opacity');
	const updateAdjustment = (content: AdjustmentContent, field: string) =>
		content.kind === 'camera-raw'
			? dispatch('camera-raw.update', {layerId: layer.id, settings: content.settings}, {mergeKey: `camera-raw:${layer.id}:${field}`})
			: dispatch('adjustment.update', {layerId: layer.id, content}, {mergeKey: `adjustment:${layer.id}:${field}`});
	const addMask = async () => {
		const client = new MaskPixelClient();
		try {
			const surface = (
				await client.create(document.width, document.height, 255)
			).surface;
			const asset = createMaskAsset(surface);
			dispatch('mask.attach', {
				layerId: layer.id,
				asset,
				mask: {
					assetId: asset.id,
					enabled: true,
					linkedToLayer: true,
					invert: false,
					feather: 0,
				},
			});
		} finally {
			client.dispose();
		}
	};
	const invertMask = () =>
		layer.mask &&
		dispatch(
			'mask.update',
			{layerId: layer.id, changes: {invert: !layer.mask.invert}},
			{mergeKey: `mask:${layer.id}:invert`},
		);
	const toggleMask = () =>
		layer.mask &&
		dispatch('mask.update', {
			layerId: layer.id,
			changes: {enabled: !layer.mask.enabled},
		});
	const toggleLink = () =>
		layer.mask &&
		dispatch('mask.update', {
			layerId: layer.id,
			changes: {
				linkedToLayer: !layer.mask.linkedToLayer,
				placement: layer.mask.linkedToLayer
					? {...layer.transform}
					: layer.mask.placement,
			},
		});
	const removeMask = () =>
		layer.mask &&
		dispatch('mask.remove', {layerId: layer.id, removeAsset: true});
	const refineMask = async () => {
		if (!layer.mask) return;
		const source = document.assets[layer.mask.assetId];
		if (!source) return;
		const client = new MaskPixelClient();
		try {
			const surface = await loadMaskSurface(source);
			const refined = await client.refine(surface, {
				smooth: 24,
				feather: layer.mask.feather,
				contrast: 12,
				shiftEdge: 0,
			});
			const asset = createMaskAsset(refined.surface, layer.mask.assetId);
			dispatch('mask.attach', {
				layerId: layer.id,
				asset,
				mask: {...layer.mask, assetId: asset.id},
			});
		} finally {
			client.dispose();
		}
	};
	const applyMask = async () => {
		if (!layer.mask || layer.content.kind !== 'pixel') return;
		const source = document.assets[layer.content.assetId];
		const maskAsset = document.assets[layer.mask.assetId];
		if (!source || !maskAsset) return;
		const mask = await loadMaskSurface(maskAsset);
		const asset = await applyMaskToRasterAsset({
			source,
			mask,
			invert: layer.mask.invert,
		});
		dispatch('mask.apply', {layerId: layer.id, asset});
	};
	const liveMaskCandidates = Object.values(document.layers).filter(
		(candidate) => candidate.id !== layer.id && candidate.kind !== 'group',
	);

	return (
		<aside
			className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[#17181c] text-white"
			aria-label="属性检查器"
			data-testid="inspector-panel"
		>
			<div className="flex h-11 shrink-0 items-center justify-between border-b border-white/8 px-3">
				<div className="min-w-0">
					<div className="truncate text-xs font-semibold">属性</div>
					<div className="truncate text-[10px] text-white/40">
						{layer.name}{' '}
						{selectedLayerIds.length > 1
							? `+ ${selectedLayerIds.length - 1}`
							: ''}
					</div>
				</div>
				<button
					type="button"
					className="flex size-7 items-center justify-center rounded text-white/55 hover:bg-white/10 hover:text-white"
					onClick={clearSelection}
					title="取消选择"
					aria-label="取消选择"
				>
					<RotateCcw className="size-3.5" />
				</button>
			</div>
			<Section title="变换">
				<div className="grid grid-cols-2 gap-2">
					<Field
						label="X"
						value={number(layer.transform.originX)}
						onChange={(value) => updateTransform('originX', value)}
					/>
					<Field
						label="Y"
						value={number(layer.transform.originY)}
						onChange={(value) => updateTransform('originY', value)}
					/>
					<Field
						label="W"
						value={number(layer.transform.width)}
						onChange={(value) => updateTransform('width', Math.max(1, value))}
					/>
					<Field
						label="H"
						value={number(layer.transform.height)}
						onChange={(value) => updateTransform('height', Math.max(1, value))}
					/>
					<Field
						label="角度"
						value={number(layer.transform.rotation)}
						step={1}
						onChange={(value) => updateTransform('rotation', value)}
					/>
					<Field
						label="缩放 X"
						value={number(layer.transform.scaleX)}
						step={0.01}
						onChange={(value) => updateTransform('scaleX', value)}
					/>
					<Field
						label="缩放 Y"
						value={number(layer.transform.scaleY)}
						step={0.01}
						onChange={(value) => updateTransform('scaleY', value)}
					/>
				</div>
				<label className="mt-2 grid grid-cols-[46px_1fr] items-center gap-2 text-[10px] text-white/55">
					<span>采样</span>
					<select
						className={inputClass}
						value={layer.transform.sampling}
						onChange={(event) =>
							updateTransform(
								'sampling',
								event.target.value as LayerNode['transform']['sampling'],
							)
						}
					>
						<option value="smooth">平滑</option>
						<option value="high">高质量</option>
						<option value="nearest">最近邻</option>
					</select>
				</label>
			</Section>
			<Section title="外观">
				<div className="mb-2 flex items-center gap-2">
					<button
						type="button"
						className="flex h-7 flex-1 items-center justify-center gap-1 rounded bg-white/7 text-[10px] hover:bg-white/12"
						onClick={() => update({visible: !layer.visible})}
					>
						{layer.visible ? (
							<Eye className="size-3.5" />
						) : (
							<EyeOff className="size-3.5" />
						)}
						{layer.visible ? '可见' : '隐藏'}
					</button>
					<button
						type="button"
						className="flex h-7 flex-1 items-center justify-center gap-1 rounded bg-white/7 text-[10px] hover:bg-white/12"
						onClick={() => update({locked: !layer.locked})}
					>
						{layer.locked ? (
							<Lock className="size-3.5" />
						) : (
							<Unlock className="size-3.5" />
						)}
						{layer.locked ? '已锁定' : '锁定'}
					</button>
				</div>
				<label className="grid grid-cols-[46px_1fr_42px] items-center gap-2 text-[10px] text-white/55">
					<span>不透明度</span>
					<input
						type="range"
						min="0"
						max="1"
						step="0.01"
						value={layer.opacity}
						onChange={(event) => updateOpacity(Number(event.target.value))}
					/>
					<span className="text-right tabular-nums">
						{Math.round(layer.opacity * 100)}%
					</span>
				</label>
				<label className="mt-2 grid grid-cols-[46px_1fr] items-center gap-2 text-[10px] text-white/55">
					<span>混合</span>
					<select
						className={inputClass}
						value={layer.blendMode}
						onChange={(event) =>
							update({blendMode: event.target.value as BlendMode})
						}
					>
						{BLEND_MODES.map((mode) => (
							<option key={mode} value={mode}>
								{mode}
							</option>
						))}
					</select>
				</label>
			</Section>
			<Section title="蒙版">
				<div className="flex items-center justify-between text-[10px] text-white/55">
					<span>
						{layer.mask
							? `${layer.kind === 'group' ? '文件夹' : '像素'}蒙版`
							: '未添加蒙版'}
					</span>
					{layer.mask ? (
						<button
							type="button"
							className="rounded bg-white/7 px-2 py-1 hover:bg-white/12"
							onClick={toggleMask}
						>
							{layer.mask.enabled ? '禁用' : '启用'}
						</button>
					) : (
						<button
							type="button"
							className="rounded bg-white/7 px-2 py-1 hover:bg-white/12"
							onClick={() => void addMask()}
						>
							添加蒙版
						</button>
					)}
				</div>
				{layer.mask ? (
					<>
						<label className="mt-2 grid grid-cols-[46px_1fr_42px] items-center gap-2 text-[10px] text-white/55">
							<span>羽化</span>
							<input
								type="range"
								min="0"
								max="200"
								step="1"
								value={layer.mask.feather}
								onChange={(event) =>
									dispatch(
										'mask.update',
										{
											layerId: layer.id,
											changes: {feather: Number(event.target.value)},
										},
										{mergeKey: `mask:${layer.id}:feather`},
									)
								}
							/>
							<span className="text-right tabular-nums">
								{layer.mask.feather}px
							</span>
						</label>
						<div className="mt-2 grid grid-cols-2 gap-1">
							<button
								type="button"
								className="h-7 rounded bg-white/7 text-[10px] hover:bg-white/12"
								onClick={invertMask}
							>
								反相
							</button>
							<button
								type="button"
								className="h-7 rounded bg-white/7 text-[10px] hover:bg-white/12"
								onClick={toggleLink}
							>
								{layer.mask.linkedToLayer ? '解除链接' : '链接图层'}
							</button>
							<button
								type="button"
								className="h-7 rounded bg-white/7 text-[10px] hover:bg-white/12"
								onClick={() => void refineMask()}
							>
								Refine Edge
							</button>
							<button
								type="button"
								disabled={layer.content.kind !== 'pixel'}
								className="h-7 rounded bg-white/7 text-[10px] hover:bg-white/12 disabled:opacity-30"
								onClick={() => void applyMask()}
							>
								应用蒙版
							</button>
							<button
								type="button"
								className="col-span-2 h-7 rounded bg-red-500/15 text-[10px] text-red-200 hover:bg-red-500/25"
								onClick={removeMask}
							>
								删除蒙版
							</button>
						</div>
					</>
				) : null}
				<label className="mt-3 grid grid-cols-[56px_1fr] items-center gap-2 text-[10px] text-white/55">
					<span>Live Mask</span>
					<select
						className={inputClass}
						value={layer.liveMask?.sourceLayerId ?? ''}
						onChange={(event) =>
							event.target.value
								? dispatch('live-mask.set', {
										layerId: layer.id,
										liveMask: {
											sourceLayerId: event.target.value,
											mode: layer.liveMask?.mode ?? 'alpha',
										},
									})
								: layer.liveMask &&
									dispatch('live-mask.remove', {layerId: layer.id})
						}
					>
						<option value="">无</option>
						{liveMaskCandidates.map((candidate) => (
							<option key={candidate.id} value={candidate.id}>
								{candidate.name}
							</option>
						))}
					</select>
				</label>
				{layer.liveMask ? (
					<label className="mt-2 grid grid-cols-[56px_1fr] items-center gap-2 text-[10px] text-white/55">
						<span>模式</span>
						<select
							className={inputClass}
							value={layer.liveMask.mode}
							onChange={(event) =>
								dispatch('live-mask.set', {
									layerId: layer.id,
									liveMask: {
										...layer.liveMask!,
										mode: event.target.value as typeof layer.liveMask.mode,
									},
								})
							}
						>
							<option value="alpha">Alpha</option>
							<option value="alpha-inverted">Alpha 反相</option>
							<option value="luma">亮度</option>
							<option value="luma-inverted">亮度反相</option>
						</select>
					</label>
				) : null}
			</Section>
			<Section title="效果">
					<div className="flex items-center justify-between text-[10px] text-white/55">
						<span>
							{layer.effects
								? `${Object.keys(layer.effects).length} 个效果`
								: '未添加效果'}
						</span>
						<div className="flex flex-wrap justify-end gap-1">
							{(Object.keys(EFFECT_LABELS) as LayerEffectKind[]).map((effect) => (
								<button key={effect} type="button" disabled={Boolean(layer.effects?.[effect])} className="rounded bg-white/7 px-2 py-1 text-[10px] hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-30" onClick={() => dispatch('effect.set', {layerId: layer.id, effect, value: effectDefaults(effect)})}>
									+ {EFFECT_LABELS[effect]}
								</button>
							))}
						</div>
					</div>
					{(Object.keys(EFFECT_LABELS) as LayerEffectKind[]).map((effect) => {
						const value = layer.effects?.[effect];
						if (!value) return null;
						return <div key={effect} className="mt-2 border border-white/8 p-2">
							<div className="flex items-center justify-between text-[10px] text-white/65">
								<label className="flex items-center gap-2"><input type="checkbox" checked={value.enabled} onChange={(event) => dispatch('effect.update', {layerId: layer.id, effect, changes: {enabled: event.target.checked}})} /><span>{EFFECT_LABELS[effect]}</span></label>
								<button type="button" className="text-red-200/70 hover:text-red-100" onClick={() => dispatch('effect.remove', {layerId: layer.id, effect})} aria-label={`删除${EFFECT_LABELS[effect]}`}>删除</button>
							</div>
							<ColorField label="颜色" value={value.color} onChange={(color) => dispatch('effect.update', {layerId: layer.id, effect, changes: {color}})} />
							{'size' in value ? <Field label="大小" value={number(value.size)} step={1} onChange={(next) => dispatch('effect.update', {layerId: layer.id, effect, changes: {size: Math.max(0, next)}})} /> : null}
							{'spread' in value ? <Field label="扩展" value={number(value.spread)} step={1} onChange={(next) => dispatch('effect.update', {layerId: layer.id, effect, changes: {spread: Math.max(0, next)}})} /> : null}
							{'angle' in value ? <Field label="角度" value={number(value.angle)} step={1} onChange={(next) => dispatch('effect.update', {layerId: layer.id, effect, changes: {angle: next}})} /> : null}
							{'distance' in value ? <Field label="距离" value={number(value.distance)} step={1} onChange={(next) => dispatch('effect.update', {layerId: layer.id, effect, changes: {distance: next}})} /> : null}
							{'opacity' in value ? <Field label="不透明度" value={number(value.opacity)} step={0.05} onChange={(next) => dispatch('effect.update', {layerId: layer.id, effect, changes: {opacity: Math.max(0, Math.min(1, next))}})} /> : null}
							{'position' in value ? <label className="grid grid-cols-[46px_1fr] items-center gap-2 text-[10px] text-white/55"><span>位置</span><select className={inputClass} value={value.position} onChange={(event) => dispatch('effect.update', {layerId: layer.id, effect, changes: {position: event.target.value as typeof value.position}})}><option value="inside">内部</option><option value="center">居中</option><option value="outside">外部</option></select></label> : null}
							{'blendMode' in value ? <label className="grid grid-cols-[46px_1fr] items-center gap-2 text-[10px] text-white/55"><span>混合</span><select className={inputClass} value={value.blendMode} onChange={(event) => dispatch('effect.update', {layerId: layer.id, effect, changes: {blendMode: event.target.value as BlendMode}})}>{BLEND_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label> : null}
						</div>;
					})}
			</Section>
				{layer.kind === 'adjustment' && layer.content.kind !== 'pixel' && layer.content.kind !== 'group' && layer.content.kind !== 'text' && layer.content.kind !== 'shape' ? (
					<Section title="调整">
						<label className="grid grid-cols-[46px_1fr] items-center gap-2 text-[10px] text-white/55">
							<span>类型</span>
							<select className={inputClass} value={layer.content.kind} onChange={(event) => {
								const kind = event.target.value as AdjustmentContent['kind'];
								if (kind === layer.content.kind) return;
								dispatch('adjustment.update', {layerId: layer.id, content: defaultAdjustment(kind)});
							}}>
								{['hue-saturation', 'levels', 'curves', 'exposure', 'gradient-map', 'grain', 'invert', 'black-white', 'color-balance', 'gaussian-blur', 'motion-blur', 'add-noise', 'camera-raw'].map((kind) => <option key={kind} value={kind}>{kind}</option>)}
							</select>
						</label>
						<AdjustmentFields
							content={layer.content}
							onChange={updateAdjustment}
						/>
					</Section>
				) : null}
				<Section title="动画">
				<div className="flex items-center justify-between text-[10px] text-white/55">
					<span>{layer.animation ? '已启用属性动画' : '静态图层'}</span>
					<button
						type="button"
						className="rounded bg-white/7 px-2 py-1 hover:bg-white/12"
						onClick={() =>
							update({
								animation: layer.animation ? undefined : {properties: {}},
							})
						}
					>
						{layer.animation ? '移除动画' : '添加动画'}
					</button>
				</div>
			</Section>
			{layer.kind === 'text' && layer.content.kind === 'text' ? (
				<Section title="文字">
					<textarea
						className={`${inputClass} h-16 resize-none py-1.5`}
						value={layer.content.text}
						onChange={(event) =>
								dispatch('text.update', {layerId: layer.id, changes: {text: event.target.value}}, {mergeKey: `text:${layer.id}:value`})
						}
					/>
					<label className="mt-2 grid grid-cols-[46px_1fr] items-center gap-2 text-[10px] text-white/55">
						<span>字体</span>
						<input
							className={inputClass}
							value={layer.content.fontFamily}
							onChange={(event) =>
								dispatch('text.update', {layerId: layer.id, changes: {fontFamily: event.target.value}}, {mergeKey: `text:${layer.id}:font`})
							}
						/>
					</label>
					<Field
						label="字号"
						value={layer.content.fontSize}
						step={1}
						onChange={(value) =>
								dispatch('text.update', {layerId: layer.id, changes: {fontSize: Math.max(1, value)}}, {mergeKey: `text:${layer.id}:size`})
						}
					/>
					<Field label="行高" value={layer.content.lineHeight} step={0.05} onChange={(lineHeight) => dispatch('text.update', {layerId: layer.id, changes: {lineHeight: Math.max(0.1, lineHeight)}}, {mergeKey: `text:${layer.id}:line-height`})} />
					<Field label="字距" value={layer.content.letterSpacing} step={0.1} onChange={(letterSpacing) => dispatch('text.update', {layerId: layer.id, changes: {letterSpacing}}, {mergeKey: `text:${layer.id}:letter-spacing`})} />
					<ColorField label="颜色" value={layer.content.color} onChange={(color) => dispatch('text.update', {layerId: layer.id, changes: {color}})} />
					<label className="grid grid-cols-[46px_1fr] items-center gap-2 text-[10px] text-white/55">
						<span>对齐</span>
						<select className={inputClass} value={layer.content.align} onChange={(event) => dispatch('text.update', {layerId: layer.id, changes: {align: event.target.value as typeof layer.content.align}})}>
							<option value="left">左</option>
							<option value="center">中</option>
							<option value="right">右</option>
						</select>
					</label>
				</Section>
			) : null}
			{layer.kind === 'shape' && layer.content.kind === 'shape' ? (
				<Section title="形状">
					<label className="grid grid-cols-[46px_1fr] items-center gap-2 text-[10px] text-white/55">
						<span>类型</span>
						<select
							className={inputClass}
							value={layer.content.shape}
							onChange={(event) =>
									dispatch('shape.update', {layerId: layer.id, changes: {shape: event.target.value as typeof layer.content.shape}})
							}
						>
							<option value="rectangle">矩形</option>
							<option value="rounded-rectangle">圆角矩形</option>
							<option value="ellipse">椭圆</option>
							<option value="line">直线</option>
						</select>
					</label>
					<ColorField label="填充" value={layer.content.fill} onChange={(fill) => dispatch('shape.update', {layerId: layer.id, changes: {fill}})} />
					<ColorField label="描边" value={layer.content.stroke ?? {r: 0, g: 0, b: 0, a: 1}} onChange={(stroke) => dispatch('shape.update', {layerId: layer.id, changes: {stroke}})} />
					<Field label="描边宽" value={layer.content.strokeWidth} onChange={(strokeWidth) => dispatch('shape.update', {layerId: layer.id, changes: {strokeWidth: Math.max(0, strokeWidth)}})} />
					{layer.content.shape === 'rounded-rectangle' ? <Field label="圆角" value={layer.content.cornerRadius ?? 0} onChange={(cornerRadius) => dispatch('shape.update', {layerId: layer.id, changes: {cornerRadius: Math.max(0, cornerRadius)}})} /> : null}
				</Section>
			) : null}
		</aside>
	);
};
