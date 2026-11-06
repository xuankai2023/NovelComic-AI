'use client';

import React, {useEffect, useRef} from 'react';
import {useDocumentWorkspace} from '../../workspace/document-workspace-context';
import {invertAffine, layerLocalMatrix, layerWorldMatrix, multiplyAffine} from '../coordinates';
import {
	TEXT_PADDING,
	colorAt,
	layoutText,
	lineHeightOf,
	paintCompositorText,
	textContentFromStyle,
} from '../type/text-style';
import {
	cancelTypeEditing,
	commitTypeEditing,
	getTypeDraft,
	getTypeEditorState,
	nudgeTypeSpacing,
	replaceTypeText,
	setTypeSelection,
	subscribeTypeEditor,
} from '../type/type-settings';

const cssColor = (color: {r: number; g: number; b: number}) => `rgb(${color.r}, ${color.g}, ${color.b})`;

const draftMatrix = (
	document: ReturnType<typeof useDocumentWorkspace>['document'],
	draft: NonNullable<ReturnType<typeof getTypeDraft>>,
) => {
	const local = layerLocalMatrix({
		originX: draft.originX,
		originY: draft.originY,
		width: draft.width,
		height: draft.height,
		rotation: draft.rotation,
		scaleX: draft.scaleX,
		scaleY: draft.scaleY,
		sampling: draft.sampling,
	});
	if (!local) return null;
	if (!draft.layerId) return local;
	const layer = document.layers[draft.layerId];
	if (!layer?.parentId) return local;
	const parent = layerWorldMatrix(document, layer.parentId);
	return parent ? multiplyAffine(parent, local) : local;
};

/** Per-letter faces are painted with the same measurer the committed layer uses. The textarea stays transparent and only owns the caret. */
const RunGlyphs: React.FC<{draft: NonNullable<ReturnType<typeof getTypeDraft>>}> = ({draft}) => {
	const ref = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const canvas = ref.current;
		const context = canvas?.getContext('2d');
		if (!canvas || !context) return;
		const ratio = window.devicePixelRatio || 1;
		canvas.width = Math.max(1, Math.ceil(draft.width * ratio));
		canvas.height = Math.max(1, Math.ceil(draft.height * ratio));
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, draft.width, draft.height);
		paintCompositorText(context, textContentFromStyle(draft.style), draft.width, draft.height);
	}, [draft]);
	return <canvas ref={ref} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />;
};

/**
 * The on-canvas text box. Glyphs are the textarea, so the caret, selection,
 * clipboard and IME stay with the browser. A paragraph box that cannot hold
 * its text shows a plus in the bottom-right handle, as in Photoshop.
 */
export const InlineTextOverlay: React.FC<{scale: number}> = ({scale}) => {
	const editor = React.useSyncExternalStore(subscribeTypeEditor, getTypeEditorState, getTypeEditorState);
	const {document} = useDocumentWorkspace();
	const draft = editor.draft;
	const field = useRef<HTMLTextAreaElement>(null);
	const composing = useRef(false);

	useEffect(() => {
		const element = field.current;
		const current = getTypeDraft();
		if (!element || !current) return;
		element.focus({preventScroll: true});
		const start = Math.min(current.selectionStart, element.value.length);
		const end = Math.min(current.selectionEnd, element.value.length);
		element.setSelectionRange(start, end);
	}, [draft?.id, editor.focusToken]);

	if (!draft) return null;
	const matrix = draftMatrix(document, draft);
	if (!matrix || !invertAffine(matrix)) return null;
	const zoom = scale || 1;
	const lineHeight = lineHeightOf(draft.style);
	const layout = layoutText(draft.style, {width: draft.width, height: draft.height}, draft.style.boxSize != null);
	const handle = Math.max(2, 6 / Math.max(0.01, zoom * Math.abs(draft.scaleX || 1)));
	const mixed = draft.style.runs.length > 0;
	const swatch = cssColor(colorAt(draft.style, Math.max(0, draft.selectionStart - 1)));
	const units = [
		{x: 0, y: 0},
		{x: 0.5, y: 0},
		{x: 1, y: 0},
		{x: 1, y: 0.5},
		{x: 1, y: 1},
		{x: 0.5, y: 1},
		{x: 0, y: 1},
		{x: 0, y: 0.5},
	];

	return (
		<div
			data-testid="inline-text-editor"
			className="absolute top-0 left-0"
			style={{
				width: draft.width,
				height: draft.height,
				transformOrigin: '0 0',
				transform: `matrix(${matrix.a * zoom}, ${matrix.b * zoom}, ${matrix.c * zoom}, ${matrix.d * zoom}, ${matrix.e * zoom}, ${matrix.f * zoom})`,
				pointerEvents: 'none',
			}}
		>
			{mixed ? <RunGlyphs draft={draft} /> : null}
			<textarea
				key={draft.id}
				ref={field}
				data-testid="inline-text-field"
				aria-label="画布文字"
				defaultValue={draft.style.content}
				spellCheck={false}
				autoCapitalize="off"
				autoCorrect="off"
				wrap={draft.style.boxSize ? 'soft' : 'off'}
				className="absolute inset-0 resize-none overflow-hidden border-0 bg-transparent p-0 outline-none"
				style={{
					boxSizing: 'border-box',
					padding: TEXT_PADDING,
					margin: 0,
					fontFamily: `"${draft.style.fontFamily}", sans-serif`,
					fontSize: draft.style.fontSize,
					lineHeight: `${lineHeight}px`,
					letterSpacing: draft.style.tracking,
					textAlign: draft.style.align,
					color: mixed ? 'transparent' : swatch,
					caretColor: swatch,
					WebkitTextFillColor: mixed ? 'transparent' : undefined,
					whiteSpace: draft.style.boxSize ? 'pre-wrap' : 'pre',
					wordBreak: 'break-word',
					pointerEvents: 'auto',
					cursor: 'text',
				}}
				onPointerDown={(event) => event.stopPropagation()}
				onCompositionStart={() => {
					composing.current = true;
				}}
				onCompositionEnd={(event) => {
					composing.current = false;
					const target = event.currentTarget;
					if (!replaceTypeText(target.value, target.selectionStart ?? 0, target.selectionEnd ?? 0)) {
						const current = getTypeDraft();
						target.value = current?.style.content ?? '';
					}
				}}
				onChange={(event) => {
					const native = event.nativeEvent;
					if (composing.current || ('isComposing' in native && native.isComposing)) return;
					const target = event.currentTarget;
					if (!replaceTypeText(target.value, target.selectionStart ?? 0, target.selectionEnd ?? 0)) {
						const current = getTypeDraft();
						target.value = current?.style.content ?? '';
					}
				}}
				onSelect={(event) => {
					const target = event.currentTarget;
					setTypeSelection(target.selectionStart ?? 0, target.selectionEnd ?? 0);
				}}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing || event.key === 'Process') return;
					if (event.key === 'Escape') {
						event.preventDefault();
						event.stopPropagation();
						cancelTypeEditing();
						return;
					}
					if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey) {
						event.preventDefault();
						event.stopPropagation();
						commitTypeEditing();
						return;
					}
					if (!event.altKey || !event.key.startsWith('Arrow')) return;
					event.preventDefault();
					event.stopPropagation();
					const step = event.shiftKey ? 10 : 1;
					if (event.key === 'ArrowLeft') nudgeTypeSpacing('tracking', -step);
					else if (event.key === 'ArrowRight') nudgeTypeSpacing('tracking', step);
					else if (event.key === 'ArrowUp') nudgeTypeSpacing('leading-up', step);
					else nudgeTypeSpacing('leading-down', step);
				}}
			/>
			<div className="pointer-events-none absolute inset-0" style={{boxShadow: 'inset 0 0 0 1px #0a84ff'}} />
			{units.map((unit, index) => (
				<span
					key={index}
					className="pointer-events-auto absolute box-border border border-[#0a84ff] bg-white"
					onMouseDown={(event) => event.preventDefault()}
					style={{
						width: handle,
						height: handle,
						left: unit.x * draft.width - handle / 2,
						top: unit.y * draft.height - handle / 2,
					}}
				>
					{layout.overflow && index === 4 ? (
						<span className="absolute inset-0 text-center text-black" style={{fontSize: handle, lineHeight: `${handle}px`}}>
							+
						</span>
					) : null}
				</span>
			))}
		</div>
	);
};
