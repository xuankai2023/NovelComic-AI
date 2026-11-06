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
	type MarqueeOutline,
} from '../document/selection-geometry';
import {
	displayedMarqueeMode,
	getMarqueeToolSettings,
	subscribeMarqueeToolSettings,
	updateMarqueeToolSettings,
} from '../tools/marquee/marquee-settings';
import {useDocumentWorkspace} from './document-workspace-context';

const modes: Array<{id: MarqueeMode; label: string}> = [
	{id: 'replace', label: '新建'},
	{id: 'add', label: '添加'},
	{id: 'subtract', label: '减去'},
];

const shapes: Array<{id: MarqueeOutline; label: string}> = [
	{id: 'rectangle', label: '矩形'},
	{id: 'ellipse', label: '椭圆'},
];

const clampAmount = (value: number, max: number) => Math.min(max, Math.max(1, Math.round(value) || 1));

export const MarqueeOptions: React.FC = () => {
	const {document, commitSelection} = useDocumentWorkspace();
	const settings = React.useSyncExternalStore(subscribeMarqueeToolSettings, getMarqueeToolSettings, getMarqueeToolSettings);
	const selection = document.selections[ACTIVE_SELECTION_ID] ?? null;
	const shape = shapeFromRecord(selection);
	const canModify = Boolean(shape && !isEmptyShape(shape) && !settings.draftActive);
	const displayed = displayedMarqueeMode(settings);
	const setAmount = (key: 'expandAmount' | 'contractAmount' | 'featherAmount', max: number, value: string) => {
		updateMarqueeToolSettings({[key]: clampAmount(Number(value), max)});
	};
	const commitShape = (next: NonNullable<typeof shape>, feather = selection?.feather ?? 0) => {
		commitSelection(selectionRecord(next, {feather, antialiased: selection?.geometry?.antialiased ?? settings.antialiased}));
	};
	return (
		<>
			<div className="flex overflow-hidden rounded border border-white/15" role="group" aria-label="选框形状">
				{shapes.map((shapeOption) => (
					<button
						key={shapeOption.id}
						type="button"
						aria-pressed={settings.kind === shapeOption.id}
						title="按 M 使用当前形状，按 Tab 在矩形和椭圆之间切换"
						className="px-2 py-1 text-[11px] aria-pressed:bg-white/15"
						onClick={() => updateMarqueeToolSettings({kind: shapeOption.id, draftMode: null, draftActive: false})}
					>
						{shapeOption.label}
					</button>
				))}
			</div>
			<div className="flex overflow-hidden rounded border border-white/15" role="group" aria-label="选区模式">
				{modes.map((mode) => (
					<button
						key={mode.id}
						type="button"
						aria-pressed={displayed === mode.id}
						title="按住 Shift 添加，按住 Option 减去"
						className="px-2 py-1 text-[11px] aria-pressed:bg-white/15"
						onClick={() => updateMarqueeToolSettings({mode: mode.id})}
					>
						{mode.label}
					</button>
				))}
			</div>
			{settings.kind === 'ellipse' ? (
				<label className="flex items-center gap-1.5" title="平滑选区边缘；关掉后是硬边">
					<input
						type="checkbox"
						checked={settings.antialiased}
						onChange={(event) => updateMarqueeToolSettings({antialiased: event.target.checked})}
					/>
					抗锯齿
				</label>
			) : null}
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
				onApply={() =>
					selection &&
					shape &&
					commitShape(shape, stackFeather(selection.feather, settings.featherAmount))
				}
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
