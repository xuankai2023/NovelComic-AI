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
import {
	displayedLassoMode,
	getLassoToolSettings,
	subscribeLassoToolSettings,
	updateLassoToolSettings,
	type LassoKind,
} from '../tools/lasso/lasso-settings';
import {useDocumentWorkspace} from './document-workspace-context';

const modes: Array<{id: MarqueeMode; label: string}> = [
	{id: 'replace', label: '新建'},
	{id: 'add', label: '添加'},
	{id: 'subtract', label: '减去'},
];

const kinds: Array<{id: LassoKind; label: string}> = [
	{id: 'freehand', label: '自由'},
	{id: 'polygonal', label: '多边形'},
];

const clampAmount = (value: number, max: number) => Math.min(max, Math.max(1, Math.round(value) || 1));

export const LassoOptions: React.FC = () => {
	const {document, commitSelection} = useDocumentWorkspace();
	const settings = React.useSyncExternalStore(subscribeLassoToolSettings, getLassoToolSettings, getLassoToolSettings);
	const selection = document.selections[ACTIVE_SELECTION_ID] ?? null;
	const shape = shapeFromRecord(selection);
	const canModify = Boolean(shape && !isEmptyShape(shape) && !settings.draftActive);
	const displayed = displayedLassoMode(settings);
	const setAmount = (key: 'expandAmount' | 'contractAmount' | 'featherAmount', max: number, value: string) => {
		updateLassoToolSettings({[key]: clampAmount(Number(value), max)});
	};
	const commitShape = (next: NonNullable<typeof shape>, feather = selection?.feather ?? 0) => {
		commitSelection(selectionRecord(next, {feather, antialiased: selection?.geometry?.antialiased ?? settings.antialiased}));
	};
	return (
		<>
			<div className="flex overflow-hidden rounded border border-white/15" role="group" aria-label="套索类型">
				{kinds.map((kind) => (
					<button
						key={kind.id}
						type="button"
						aria-pressed={settings.kind === kind.id}
						title="按 L 使用当前套索，按 Tab 在自由套索和多边形套索之间切换"
						className="px-2 py-1 text-[11px] aria-pressed:bg-white/15"
						onClick={() => updateLassoToolSettings({kind: kind.id, draftMode: null, draftActive: false})}
					>
						{kind.label}
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
						onClick={() => updateLassoToolSettings({mode: mode.id})}
					>
						{mode.label}
					</button>
				))}
			</div>
			<label className="flex items-center gap-1.5" title="平滑选区边缘；关掉后是硬边">
				<input
					type="checkbox"
					checked={settings.antialiased}
					onChange={(event) => updateLassoToolSettings({antialiased: event.target.checked})}
				/>
				抗锯齿
			</label>
			<span className="h-[18px] w-px shrink-0 bg-white/20" aria-hidden />
			<AmountButton
				label="扩展"
				amount={settings.expandAmount}
				disabled={!canModify}
				fieldDisabled={!canModify}
				title="按这个像素数扩展选区"
				onAmount={(value) => setAmount('expandAmount', 500, value)}
				onApply={() => shape && commitShape(expandShape(shape, settings.expandAmount, document))}
			/>
			<AmountButton
				label="收缩"
				amount={settings.contractAmount}
				disabled={!canModify}
				fieldDisabled={!canModify}
				title="按这个像素数收缩选区"
				onAmount={(value) => setAmount('contractAmount', 500, value)}
				onApply={() => shape && commitShape(contractShape(shape, settings.contractAmount))}
			/>
			<AmountButton
				label="羽化"
				amount={settings.featherAmount}
				disabled={!canModify}
				title="按这个像素数柔化选区边缘"
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
	fieldDisabled?: boolean;
	title: string;
	onAmount: (value: string) => void;
	onApply: () => void;
}> = ({label, amount, disabled, fieldDisabled = false, title, onAmount, onApply}) => (
	<label className="flex items-center gap-1" title={title}>
		<button type="button" className="rounded border border-white/15 px-2 py-1 text-[11px] disabled:opacity-40" disabled={disabled} onClick={onApply}>
			{label}
		</button>
		<input
			aria-label={label}
			className="h-6 w-12 rounded border border-white/10 bg-black/20 px-1.5 text-[11px] disabled:opacity-40"
			type="number"
			min="1"
			value={amount}
			disabled={fieldDisabled}
			onChange={(event) => onAmount(event.target.value)}
		/>
		<span className="text-[11px] text-white/45">px</span>
	</label>
);
