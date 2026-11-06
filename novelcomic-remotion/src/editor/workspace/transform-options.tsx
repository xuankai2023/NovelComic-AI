'use client';

import React, {useEffect, useState} from 'react';
import type {DocumentState, LayerTransform} from '../document/types';
import {
	fromPlaced,
	isValidPlaced,
	pixelSizeOf,
	scalePercent,
	scalePlaced,
	toPlaced,
	type PlacedTransform,
} from '../tools/move/transform-math';
import {
	getMoveToolSettings,
	subscribeMoveToolSettings,
	updateMoveToolSettings,
} from '../tools/move/move-tool-settings';
import {useDocumentWorkspace} from './document-workspace-context';

const format = (value: number) =>
	Math.abs(value - Math.round(value)) < 0.005
		? String(Math.round(value))
		: value.toFixed(2);

const withTransform = (
	document: DocumentState,
	layerId: string,
	transform: LayerTransform,
): DocumentState => ({
	...document,
	layers: {
		...document.layers,
		[layerId]: {...document.layers[layerId], transform},
	},
});

export const TransformOptions: React.FC = () => {
	const {document, movePreview, setMovePreview, activeLayerId, dispatch} =
		useDocumentWorkspace();
	const settings = React.useSyncExternalStore(
		subscribeMoveToolSettings,
		getMoveToolSettings,
		getMoveToolSettings,
	);
	const [commandHeld, setCommandHeld] = useState(false);
	const [shiftHeld, setShiftHeld] = useState(false);
	useEffect(() => {
		const sync = (event: KeyboardEvent | FocusEvent) => {
			if (event instanceof FocusEvent) {
				setCommandHeld(false);
				setShiftHeld(false);
				return;
			}
			setCommandHeld(event.metaKey);
			setShiftHeld(event.shiftKey);
		};
		const clear = () => {
			setCommandHeld(false);
			setShiftHeld(false);
		};
		window.addEventListener('keydown', sync);
		window.addEventListener('keyup', sync);
		window.addEventListener('blur', clear);
		return () => {
			window.removeEventListener('keydown', sync);
			window.removeEventListener('keyup', sync);
			window.removeEventListener('blur', clear);
		};
	}, []);
	const shown = movePreview ?? document;
	const layer = activeLayerId ? shown.layers[activeLayerId] : undefined;
	const autoSelect = settings.autoSelect !== commandHeld;
	const lockRatio = settings.lockRatio !== shiftHeld;
	const placed = layer ? toPlaced(layer.transform) : null;
	const pixels = layer ? pixelSizeOf(document, layer) : {width: 1, height: 1};
	const value = placed ?? emptyPlaced();
	const disabled = !layer || !placed;

	const preview = (next: LayerTransform) => {
		if (!layer || !isValidPlaced(toPlaced(next))) return;
		setMovePreview(withTransform(document, layer.id, next));
	};
	const commit = (next: LayerTransform) => {
		if (!layer) return;
		setMovePreview(null);
		if (!isValidPlaced(toPlaced(next))) return;
		dispatch('layer.transform', {layerId: layer.id, transform: next});
	};
	const changePlaced = (
		update: (current: ReturnType<typeof toPlaced>) => ReturnType<typeof toPlaced>,
		done: boolean,
	) => {
		if (!layer) return;
		const source = (movePreview ?? document).layers[layer.id]?.transform ?? layer.transform;
		const next = fromPlaced(update(toPlaced(source)));
		if (done) commit(next);
		else preview(next);
	};

	const cancel = () => setMovePreview(null);
	const apply = () => {
		if (!layer || !movePreview) return;
		const next = movePreview.layers[layer.id]?.transform;
		if (next) commit(next);
	};

	return (
		<>
			<span className="shrink-0 text-[13px] font-semibold text-white/90">Transform</span>
			<label className="flex shrink-0 items-center gap-1.5" title="点画布选中指针下的图层。按住 Command 时临时反过来。">
				<input
					type="checkbox"
					checked={autoSelect}
					data-testid="transform-auto-select"
					onChange={(event) =>
						updateMoveToolSettings({
							autoSelect: event.target.checked !== commandHeld,
						})
					}
				/>
				Auto Select
			</label>
			<label className="flex shrink-0 items-center gap-1.5" title="显示变换框和手柄（⌘H）。隐藏后，在任意位置拖动都会移动图层。">
				<input
					type="checkbox"
					checked={settings.showControls}
					data-testid="transform-show-controls"
					onChange={(event) =>
						updateMoveToolSettings({showControls: event.target.checked})
					}
				/>
				Show Controls
			</label>
			<div className={`flex min-w-0 flex-1 items-center gap-3 overflow-x-auto ${disabled ? 'pointer-events-none opacity-40' : ''}`}>
				<NumberField label="X" value={value.originX} onChange={(next, done) => changePlaced((current) => ({...current, originX: next}), done)} />
				<NumberField label="Y" value={value.originY} onChange={(next, done) => changePlaced((current) => ({...current, originY: next}), done)} />
				<NumberField label="W" value={value.placedWidth} min={1} onChange={(next, done) => changePlaced((current) => resizePlaced(current, next, true, lockRatio), done)} />
				<NumberField label="H" value={value.placedHeight} min={1} onChange={(next, done) => changePlaced((current) => resizePlaced(current, next, false, lockRatio), done)} />
				<button
					type="button"
					aria-pressed={lockRatio}
					aria-label="Lock aspect ratio"
					title="锁定宽高比。按住 Shift 拖动手柄时临时反过来。"
					className={`shrink-0 rounded border px-1.5 py-0.5 ${lockRatio ? 'border-sky-300/70 text-sky-100' : 'border-white/10 text-white/50'}`}
					onClick={() =>
						updateMoveToolSettings({lockRatio: !settings.lockRatio})
					}
				>
					<LinkIcon />
				</button>
				<NumberField
					label="Scale"
					suffix="%"
					value={scalePercent(value, pixels)}
					min={0.1}
					onChange={(next, done) =>
						changePlaced((current) => (next > 0 ? scalePlaced(current, next, pixels) : current), done)
					}
				/>
				<NumberField
					label="°"
					value={value.rotation}
					onChange={(next, done) =>
						changePlaced((current) => ({...current, rotation: next % 360}), done)
					}
				/>
				<label className="flex shrink-0 items-center gap-1">
					Sampling
					<select
						className="h-6 rounded border border-white/10 bg-black/20 px-1 text-[11px]"
						aria-label="Sampling"
						value={value.sampling}
						onChange={(event) => {
							if (!layer) return;
							commit({
								...layer.transform,
								sampling: event.target.value as LayerTransform['sampling'],
							});
						}}
					>
						<option value="nearest">Nearest</option>
						<option value="smooth">Smooth</option>
						<option value="high">High quality</option>
					</select>
				</label>
				<button type="button" className="shrink-0 rounded border border-white/10 px-1.5 py-0.5" onClick={() => changePlaced((current) => ({...current, flipX: !current.flipX}), true)}>
					Flip H
				</button>
				<button type="button" className="shrink-0 rounded border border-white/10 px-1.5 py-0.5" onClick={() => changePlaced((current) => ({...current, flipY: !current.flipY}), true)}>
					Flip V
				</button>
			</div>
			<div className="flex shrink-0 items-center gap-3">
				<button
					type="button"
					className="rounded border border-white/10 px-1.5 py-0.5 disabled:opacity-40"
					data-testid="transform-cancel"
					disabled={!movePreview}
					onClick={cancel}
				>
					Cancel
				</button>
				<button
					type="button"
					className="rounded border border-white/10 px-1.5 py-0.5 disabled:opacity-40"
					data-testid="transform-apply"
					disabled={!movePreview}
					onClick={apply}
				>
					Apply
				</button>
			</div>
		</>
	);
};

const emptyPlaced = (): PlacedTransform => ({
	originX: 0,
	originY: 0,
	contentWidth: 1,
	contentHeight: 1,
	placedWidth: 1,
	placedHeight: 1,
	rotation: 0,
	flipX: false,
	flipY: false,
	sampling: 'high',
});

const LinkIcon: React.FC = () => (
	<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="inline-block">
		<path
			d="M4.2 6.4 3 7.6a2 2 0 0 0 2.8 2.8l1.2-1.2M7.8 5.6 9 4.4A2 2 0 0 0 6.2 1.6L5 2.8M4.4 7.6l3.2-3.2"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.2"
			strokeLinecap="round"
		/>
	</svg>
);

const resizePlaced = (
	placed: ReturnType<typeof toPlaced>,
	value: number,
	width: boolean,
	lockRatio: boolean,
) => {
	if (value < 1) return placed;
	const next = {...placed};
	if (width) {
		if (lockRatio) next.placedHeight *= value / next.placedWidth;
		next.placedWidth = value;
	} else {
		if (lockRatio) next.placedWidth *= value / next.placedHeight;
		next.placedHeight = value;
	}
	return next;
};

const NumberField: React.FC<{
	label: string;
	value: number;
	min?: number;
	suffix?: string;
	onChange: (value: number, done: boolean) => void;
}> = ({label, value, min, suffix, onChange}) => {
	const [text, setText] = useState(format(value));
	const [focused, setFocused] = useState(false);
	useEffect(() => {
		if (!focused) setText(format(value));
	}, [focused, value]);
	return (
		<label className="flex shrink-0 items-center gap-1">
			<span className="text-white/45">{label}</span>
			<input
				className="h-6 w-14 rounded border border-white/10 bg-black/20 px-1 text-[11px] outline-none"
				aria-label={label}
				value={text}
				onFocus={() => setFocused(true)}
				onBlur={() => {
					setFocused(false);
					const number = Number(text);
					if (Number.isFinite(number)) onChange(number, true);
				}}
				onKeyDown={(event) => {
					if (event.key === 'Enter') event.currentTarget.blur();
				}}
				onChange={(event) => {
					setText(event.target.value);
					const number = Number(event.target.value);
					if (!Number.isFinite(number)) return;
					if (min !== undefined && number < min) return;
					onChange(number, false);
				}}
			/>
			{suffix ? <span className="text-white/45">{suffix}</span> : null}
		</label>
	);
};
