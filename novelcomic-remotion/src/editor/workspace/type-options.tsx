'use client';

import React, {useEffect, useRef, useState} from 'react';
import {colorToHex, getBrushToolSettings, hexToColor, subscribeBrushToolSettings} from '../tools/brush/brush-settings';
import {TYPE_FONTS} from '../tools/type/text-style';
import {
	cancelTypeEditing,
	changeTypeStyle,
	commitTypeEditing,
	currentTypeStyle,
	editTextLayer,
	endTypeFontPreview,
	getTypeEditorState,
	keepTypeFontPreview,
	previewTypeFont,
	setTypeFace,
	setTypeSwatchColor,
	subscribeTypeEditor,
	typeFontName,
	typeSwatchColor,
} from '../tools/type/type-settings';
import {useDocumentWorkspace} from './document-workspace-context';

const numberValue = (value: string, fallback: number) => {
	const next = Number(value);
	return Number.isFinite(next) ? next : fallback;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Font, size, color, alignment, tracking and leading.
 * Cancel and Done are only there while a draft is open. Edit Text opens the
 * selected text layer. Nothing here writes history until the draft is committed.
 */
export const TypeOptions: React.FC = () => {
	const {document, activeLayerId} = useDocumentWorkspace();
	const editor = React.useSyncExternalStore(subscribeTypeEditor, getTypeEditorState, getTypeEditorState);
	const brush = React.useSyncExternalStore(subscribeBrushToolSettings, getBrushToolSettings, getBrushToolSettings);
	const style = currentTypeStyle(document, activeLayerId);
	const face = typeFontName(editor.draft, style.fontFamily);
	const swatch = typeSwatchColor(editor.draft, brush.foreground);
	const colorInput = useRef<HTMLInputElement>(null);
	const menuAnchor = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [menuBox, setMenuBox] = useState<{left: number; top: number; width: number} | null>(null);
	const faces = face && !(TYPE_FONTS as readonly string[]).includes(face) ? [face, ...TYPE_FONTS] : [...TYPE_FONTS];
	const activeText = activeLayerId ? document.layers[activeLayerId] : undefined;
	const canEdit = Boolean(activeText && activeText.kind === 'text' && activeText.content.kind === 'text' && !activeText.locked);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.isComposing || event.key === 'Process' || event.key !== 'Escape') return;
			event.preventDefault();
			event.stopPropagation();
			endTypeFontPreview();
			setOpen(false);
		};
		const close = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (menuAnchor.current?.contains(target)) return;
			if (target instanceof Element && target.closest('[data-testid="type-font-menu"]')) return;
			endTypeFontPreview();
			setOpen(false);
		};
		window.addEventListener('keydown', onKey, true);
		window.addEventListener('pointerdown', close);
		return () => {
			window.removeEventListener('keydown', onKey, true);
			window.removeEventListener('pointerdown', close);
		};
	}, [open]);

	const showMenu = () => {
		const rect = menuAnchor.current?.getBoundingClientRect();
		if (rect) setMenuBox({left: rect.left, top: rect.bottom + 4, width: Math.max(210, rect.width)});
		setOpen(true);
	};

	return (
		<>
			<div className="relative">
				<button
					ref={menuAnchor}
					type="button"
					className="h-6 w-[210px] truncate rounded border border-white/15 bg-black/20 px-2 text-left text-[11px]"
					style={{fontFamily: face ? `"${face}", sans-serif` : undefined}}
					aria-label="字体"
					aria-expanded={open}
					title="字体，含粗体和斜体"
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => (open ? (endTypeFontPreview(), setOpen(false)) : showMenu())}
				>
					{face || '(多种字体)'}
				</button>
				{open && menuBox ? (
					<div
						data-testid="type-font-menu"
						className="fixed z-40 max-h-64 w-[210px] overflow-auto rounded border border-white/15 bg-[#2a2a2a] py-1 shadow-lg"
						style={{left: menuBox.left, top: menuBox.top, width: menuBox.width}}
						onMouseLeave={() => endTypeFontPreview()}
					>
						{faces.map((name) => (
							<button
								key={name}
								type="button"
								className="block w-full truncate px-2 py-1 text-left text-[12px] hover:bg-white/10"
								style={{fontFamily: `"${name}", sans-serif`}}
								onMouseEnter={() => previewTypeFont(name)}
								onMouseDown={(event) => {
									event.preventDefault();
									keepTypeFontPreview();
									setTypeFace(document, activeLayerId, name);
									setOpen(false);
								}}
							>
								{name}
							</button>
						))}
					</div>
				) : null}
			</div>
			<label className="flex items-center gap-1.5">
				字号
				<input
					className="h-6 w-14 rounded border border-white/10 bg-black/20 px-1.5 text-right text-[11px]"
					type="number"
					min={1}
					max={2000}
					aria-label="字号"
					value={Math.round(style.fontSize)}
					onChange={(event) => {
						const fontSize = clamp(Math.round(numberValue(event.target.value, style.fontSize)), 1, 2000);
						changeTypeStyle(document, activeLayerId, (next) => {
							next.fontSize = fontSize;
						});
					}}
				/>
			</label>
			<button
				type="button"
				className="h-[18px] w-9 rounded-[3px] border border-black/50"
				style={{backgroundColor: colorToHex(swatch)}}
				aria-label="文字颜色"
				title="文字颜色"
				onClick={() => colorInput.current?.click()}
			/>
			<input
				ref={colorInput}
				className="sr-only"
				type="color"
				aria-label="选择文字颜色"
				value={colorToHex(swatch)}
				onChange={(event) => {
					const next = hexToColor(event.target.value);
					if (next) setTypeSwatchColor(document, activeLayerId, next);
				}}
			/>
			<div className="flex overflow-hidden rounded border border-white/15" role="group" aria-label="对齐">
				{(
					[
						['left', '左对齐'],
						['center', '居中'],
						['right', '右对齐'],
					] as const
				).map(([align, label]) => (
					<button
						key={align}
						type="button"
						aria-label={label}
						aria-pressed={style.align === align}
						className="px-2 py-1 text-[11px] aria-pressed:bg-white/15"
						onClick={() =>
							changeTypeStyle(document, activeLayerId, (next) => {
								next.align = align;
							})
						}
					>
						{align === 'left' ? '左' : align === 'center' ? '中' : '右'}
					</button>
				))}
			</div>
			<label className="flex items-center gap-1.5" title="字母间距">
				字距
				<input
					className="h-6 w-14 rounded border border-white/10 bg-black/20 px-1.5 text-right text-[11px]"
					type="number"
					min={-100}
					max={1000}
					aria-label="字距"
					value={Math.round(style.tracking)}
					onChange={(event) => {
						const tracking = clamp(Math.round(numberValue(event.target.value, style.tracking)), -100, 1000);
						changeTypeStyle(document, activeLayerId, (next) => {
							next.tracking = tracking;
						});
					}}
				/>
			</label>
			<label className="flex items-center gap-1.5" title="行高，基线到基线。空着或 0 是自动：字号的 120%。">
				行距
				<input
					className="h-6 w-14 rounded border border-white/10 bg-black/20 px-1.5 text-right text-[11px]"
					type="number"
					min={0}
					max={5000}
					placeholder="自动"
					aria-label="行距"
					value={style.leading > 0 ? Math.round(style.leading) : ''}
					onChange={(event) => {
						const typed = event.target.value.trim();
						const leading = typed === '' ? 0 : clamp(numberValue(typed, 0), 0, 5000);
						changeTypeStyle(document, activeLayerId, (next) => {
							next.leading = leading;
						});
					}}
				/>
			</label>
			{editor.draft ? (
				<>
					<button type="button" className="rounded border border-white/15 px-2 py-1 text-[11px]" onClick={() => cancelTypeEditing()}>
						取消
					</button>
					<button type="button" className="rounded border border-white/15 px-2 py-1 text-[11px]" onClick={() => commitTypeEditing()}>
						完成
					</button>
				</>
			) : (
				<button
					type="button"
					className="rounded border border-white/15 px-2 py-1 text-[11px] disabled:opacity-40"
					disabled={!canEdit}
					onClick={() => {
						if (activeText?.kind === 'text') editTextLayer(activeText);
					}}
				>
					编辑文字
				</button>
			)}
			{editor.error ? <span className="text-[#ffb4b4]">{editor.error}</span> : null}
			{editor.fontWarning ? <span className="text-[#ffd59a]">{editor.fontWarning}</span> : null}
		</>
	);
};
