'use client';

import React from 'react';
import {
	clampZoomPercent,
	formatZoomPercent,
	zoomFromPercentText,
} from '../tools/navigation/zoom-percent';
import {ViewportStore, useViewportSnapshot} from '../viewport/viewport-store';

/**
 * NavigationToolHeader's zoom field. Up and Down step one percent, Shift steps ten.
 * Return or leaving the field applies. Dragging the % unit scrubs, one percent per pixel.
 */
export const ZoomPercentField: React.FC<{viewportStore: ViewportStore}> = ({viewportStore}) => {
	const {transform} = useViewportSnapshot(viewportStore);
	const [text, setText] = React.useState(() => formatZoomPercent(transform.zoom));
	const [focused, setFocused] = React.useState(false);
	const displayed = React.useRef(text);
	const textRef = React.useRef(text);
	textRef.current = text;

	React.useEffect(() => {
		if (focused) return;
		const next = formatZoomPercent(transform.zoom);
		displayed.current = next;
		textRef.current = next;
		setText(next);
	}, [focused, transform.zoom]);

	const show = (next: string) => {
		displayed.current = next;
		textRef.current = next;
		setText(next);
	};

	const center = () => {
		const size = viewportStore.getSnapshot().viewport;
		return {x: size.width / 2, y: size.height / 2};
	};

	const applyFactor = (zoom: number) => {
		viewportStore.zoomAt(center(), zoom);
		show(formatZoomPercent(viewportStore.getSnapshot().transform.zoom));
	};

	const applyText = () => {
		if (textRef.current !== displayed.current) {
			const zoom = zoomFromPercentText(textRef.current);
			if (zoom != null) viewportStore.zoomAt(center(), zoom);
		}
		show(formatZoomPercent(viewportStore.getSnapshot().transform.zoom));
	};

	const step = (percent: number) => applyFactor(clampZoomPercent(percent) / 100);

	return (
		<label className="flex items-center gap-0.5" title="缩放百分比（0.1–3200%）。按回车应用。">
			<input
				aria-label="缩放百分比"
				className="h-6 w-[72px] rounded border border-white/15 bg-black/25 px-1.5 text-right text-[12px] text-white/85"
				data-testid="zoom-percent"
				inputMode="decimal"
				value={text}
				onBlur={() => {
					setFocused(false);
					applyText();
				}}
				onChange={(event) => {
					textRef.current = event.target.value;
					setText(event.target.value);
				}}
				onFocus={() => setFocused(true)}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						applyText();
						event.currentTarget.blur();
						return;
					}
					if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
					event.preventDefault();
					event.stopPropagation();
					const current = Number(textRef.current.replaceAll('%', ''));
					const base = Number.isFinite(current) ? current : transform.zoom * 100;
					const amount = (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
					step(base + amount);
				}}
			/>
			<span
				className="cursor-ew-resize select-none px-0.5 text-[12px] text-white/55"
				title="拖动调整缩放"
				onPointerDown={(event) => {
					event.preventDefault();
					const startX = event.clientX;
					const start = transform.zoom * 100;
					const target = event.currentTarget;
					target.setPointerCapture(event.pointerId);
					const onMove = (move: PointerEvent) => step(start + (move.clientX - startX));
					const onUp = () => {
						target.removeEventListener('pointermove', onMove);
						target.removeEventListener('pointerup', onUp);
					};
					target.addEventListener('pointermove', onMove);
					target.addEventListener('pointerup', onUp);
				}}
			>
				%
			</span>
		</label>
	);
};
