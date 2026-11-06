'use client';

import React from 'react';
import {
	ACTIVE_SELECTION_ID,
	contractShape,
	expandShape,
	isEmptyShape,
	selectionRecord,
	shapeFromRecord,
	stackFeather,
	type MarqueeMode,
} from '../document/selection-geometry';
import type {WandSampleSize} from '../pixels/wand';
import {
	displayedWandMode,
	getWandToolSettings,
	subscribeWandToolSettings,
	updateWandToolSettings,
} from '../tools/wand/wand-settings';
import {useDocumentWorkspace} from './document-workspace-context';

const modes: Array<{id: MarqueeMode; label: string}> = [
	{id: 'replace', label: '新建'},
	{id: 'add', label: '添加'},
	{id: 'subtract', label: '减去'},
];

const sampleSizes: Array<{id: WandSampleSize; label: string}> = [
	{id: 'point', label: '点采样'},
	{id: 'three', label: '3×3 平均'},
	{id: 'five', label: '5×5 平均'},
];

const clampAmount = (value: number, max: number) => Math.min(max, Math.max(1, Math.round(value) || 1));
const clampTolerance = (value: number) => Math.min(255, Math.max(0, Math.round(value) || 0));

export const WandOptions: React.FC = () => {
	const {document, commitSelection} = useDocumentWorkspace();
	const settings = React.useSyncExternalStore(subscribeWandToolSettings, getWandToolSettings, getWandToolSettings);
	const selection = document.selections[ACTIVE_SELECTION_ID] ?? null;
	const shape = shapeFromRecord(selection);
	const canModify = Boolean(shape && !isEmptyShape(shape));
	const displayed = displayedWandMode(settings);
	const setAmount = (key: 'expandAmount' | 'contractAmount' | 'featherAmount', max: number, value: string) => {
		updateWandToolSettings({[key]: clampAmount(Number(value), max)});
	};
	const commitShape = (next: NonNullable<typeof shape>, feather = selection?.feather ?? 0) => {
		commitSelection(selectionRecord(next, {feather, antialiased: selection?.geometry?.antialiased ?? settings.antialiased}));
	};
	return (
		<>
			<div className="flex overflow-hidden rounded border border-white/15" role="group" aria-label="选区模式">
				{modes.map((mode) => (
					<button
						key={mode.id}
						type="button"
						aria-pressed={displayed === mode.id}
						title="按住 Shift 添加，按住 Option 减去"
						className="px-2 py-1 text-[11px] aria-pressed:bg-white/15"
						onClick={() => updateWandToolSettings({mode: mode.id})}
					>
						{mode.label}
					</button>
				))}
			</div>
			<label className="flex items-center gap-1.5" title="每个通道（含透明度）和点击颜色相差多少以内仍会被选中">
				容差
				<input
					aria-label="容差"
					className="h-6 w-14 rounded border border-white/10 bg-black/20 px-1.5 text-[11px]"
					type="number"
					min="0"
					max="255"
					value={settings.tolerance}
					onChange={(event) => updateWandToolSettings({tolerance: clampTolerance(Number(event.target.value))})}
				/>
			</label>
			<label className="flex items-center gap-1.5" title="匹配点击的那个像素，或它周围像素的平均值">
				采样大小
				<select
					aria-label="采样大小"
					className="h-6 rounded border border-white/10 bg-black/20 px-1.5 text-[11px]"
					value={settings.sampleSize}
					onChange={(event) => updateWandToolSettings({sampleSize: event.target.value as WandSampleSize})}
				>
					{sampleSizes.map((size) => (
						<option key={size.id} value={size.id}>
							{size.label}
						</option>
					))}
				</select>
			</label>
			<div className="flex overflow-hidden rounded border border-white/15" role="group" aria-label="采样来源">
				<button
					type="button"
					aria-pressed={!settings.sampleAllLayers}
					title="只读取当前图层的颜色"
					className="px-2 py-1 text-[11px] aria-pressed:bg-white/15"
					onClick={() => updateWandToolSettings({sampleAllLayers: false})}
				>
					当前图层
				</button>
				<button
					type="button"
					aria-pressed={settings.sampleAllLayers}
					title="读取画面上每一个可见图层叠在一起的颜色"
					className="px-2 py-1 text-[11px] aria-pressed:bg-white/15"
					onClick={() => updateWandToolSettings({sampleAllLayers: true})}
				>
					所有图层
				</button>
			</div>
			<label className="flex items-center gap-1.5" title="只选中和点击处相连的相近像素；关掉后，画面上所有相近像素都会被选中">
				<input
					type="checkbox"
					checked={settings.contiguous}
					onChange={(event) => updateWandToolSettings({contiguous: event.target.checked})}
				/>
				连续
			</label>
			<label className="flex items-center gap-1.5" title="平滑选区边缘；关掉后是硬边">
				<input
					type="checkbox"
					checked={settings.antialiased}
					onChange={(event) => updateWandToolSettings({antialiased: event.target.checked})}
				/>
				抗锯齿
			</label>
			<AmountButton
				label="扩展"
				amount={settings.expandAmount}
				disabled={!canModify}
				onAmount={(value) => setAmount('expandAmount', 500, value)}
				onApply={() => shape && commitShape(expandShape(shape, settings.expandAmount, document))}
			/>
			<AmountButton
				label="收缩"
				amount={settings.contractAmount}
				disabled={!canModify}
				onAmount={(value) => setAmount('contractAmount', 500, value)}
				onApply={() => shape && commitShape(contractShape(shape, settings.contractAmount))}
			/>
			<AmountButton
				label="羽化"
				amount={settings.featherAmount}
				disabled={!canModify}
				onAmount={(value) => setAmount('featherAmount', 250, value)}
				onApply={() => selection && shape && commitShape(shape, stackFeather(selection.feather, settings.featherAmount))}
			/>
			{selection ? (
				<>
					{isEmptyShape(shape) ? <span className="text-white/45">空选区</span> : null}
					<button type="button" className="rounded border border-white/15 px-2 py-1 text-[11px]" onClick={() => commitSelection(null)}>
						取消选择
					</button>
				</>
			) : null}
		</>
	);
};

const AmountButton: React.FC<{
	label: string;
	amount: number;
	disabled: boolean;
	onAmount: (value: string) => void;
	onApply: () => void;
}> = ({label, amount, disabled, onAmount, onApply}) => (
	<label className="flex items-center gap-1">
		<button type="button" className="rounded border border-white/15 px-2 py-1 text-[11px] disabled:opacity-40" disabled={disabled} onClick={onApply}>
			{label}
		</button>
		<input
			aria-label={label}
			className="h-6 w-12 rounded border border-white/10 bg-black/20 px-1.5 text-[11px]"
			type="number"
			min="1"
			value={amount}
			onChange={(event) => onAmount(event.target.value)}
		/>
	</label>
);
