import type {DocumentState, LayerNode, LayerTransform} from '../../document/types';
import {getBrushToolSettings, setBrushForeground, type BrushColor} from '../brush/brush-settings';
import {
	boxIsValid,
	cloneTextStyle,
	colorAt,
	defaultTextStyle,
	fontAt,
	fontFaceWarning,
	isValidTextStyle,
	lineHeightOf,
	measurePointText,
	pinTextOrigin,
	replaceTextContent,
	setTextColor,
	setTextFont,
	styleFromTextContent,
	textFits,
	textTooLargeMessage,
	uniformFont,
	type TextStyle,
} from './text-style';

/**
 * Type defaults and the open draft. They are tool state, not a document undo step.
 * The draft becomes one history item only when it is committed.
 */
export type TextDraft = {
	id: string;
	layerId: string | null;
	originX: number;
	originY: number;
	width: number;
	height: number;
	rotation: number;
	scaleX: number;
	scaleY: number;
	sampling: LayerTransform['sampling'];
	style: TextStyle;
	selectionStart: number;
	selectionEnd: number;
	originalStyle: TextStyle | null;
	originalTransform: LayerTransform | null;
};

export type TypeEditorState = {
	defaults: TextStyle;
	draft: TextDraft | null;
	error: string | null;
	fontWarning: string | null;
	focusToken: number;
	/** The style before a font menu started previewing faces. */
	fontPreviewOriginal: TextStyle | null;
};

type TypeActions = {
	commit: () => boolean;
	cancel: () => void;
	nudge: (kind: 'tracking' | 'leading-up' | 'leading-down', step: number) => void;
};

const listeners = new Set<() => void>();
let pendingEditLayerId: string | null = null;
let actions: TypeActions | null = null;

const initial = (): TypeEditorState => ({
	defaults: defaultTextStyle(),
	draft: null,
	error: null,
	fontWarning: null,
	focusToken: 0,
	fontPreviewOriginal: null,
});

let state = initial();

const emit = (next: TypeEditorState) => {
	state = next;
	for (const listener of listeners) listener();
};

const draftId = () =>
	typeof globalThis.crypto?.randomUUID === 'function'
		? `text-${globalThis.crypto.randomUUID()}`
		: `text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export const getTypeEditorState = () => state;
export const getTypeDraft = () => state.draft;
export const subscribeTypeEditor = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export const bindTypeActions = (next: TypeActions | null) => {
	actions = next;
};

export const commitTypeEditing = () => actions?.commit() ?? false;
export const cancelTypeEditing = () => actions?.cancel();
export const nudgeTypeSpacing = (kind: 'tracking' | 'leading-up' | 'leading-down', step: number) =>
	actions?.nudge(kind, step);

export const queueLiveTextEdit = (layerId: string) => {
	pendingEditLayerId = layerId;
};

export const takeLiveTextEdit = () => {
	const id = pendingEditLayerId;
	pendingEditLayerId = null;
	return id;
};

export const setTypeError = (error: string | null) => {
	if (state.error === error) return;
	emit({...state, error});
};

export const typeStatusHint = () => '单击创建点文字，拖出段落框 · ⌘/Ctrl+Enter 提交 · Esc 取消';

const selectionOf = (draft: TextDraft) => {
	const count = draft.style.content.length;
	const start = Math.max(0, Math.min(draft.selectionStart, count));
	const end = Math.max(start, Math.min(draft.selectionEnd, count));
	return {start, end};
};

/** What the font menu shows. A caret uses the letter before it. Mixed faces show nothing until one is chosen. */
export const typeFontName = (draft: TextDraft | null, fallback: string) => {
	if (!draft) return fallback;
	const {start, end} = selectionOf(draft);
	if (end === start) return fontAt(draft.style, Math.max(0, start - 1));
	return uniformFont(draft.style, start, end) ?? '';
};

export const typeSwatchColor = (draft: TextDraft | null, foreground: BrushColor): BrushColor => {
	if (!draft) return foreground;
	const {start, end} = selectionOf(draft);
	return colorAt(draft.style, end > start ? start : Math.max(0, start - 1));
};

export const currentTypeStyle = (document: DocumentState, activeLayerId: string | null): TextStyle => {
	if (state.draft) return state.draft.style;
	const layer = activeLayerId ? document.layers[activeLayerId] : undefined;
	if (layer?.kind === 'text' && layer.content.kind === 'text') return styleFromTextContent(layer.content, layer.transform);
	return state.defaults;
};

const withMeasuredStyle = (draft: TextDraft, style: TextStyle): TextDraft | null => {
	if (!isValidTextStyle(style) || !textFits(style)) return null;
	if (style.boxSize) {
		if (!boxIsValid(style.boxSize)) return null;
		return {...draft, style, width: style.boxSize.width, height: style.boxSize.height};
	}
	const size = measurePointText(style);
	if (!boxIsValid(size)) return null;
	const before: LayerTransform = {
		originX: draft.originX,
		originY: draft.originY,
		width: draft.width,
		height: draft.height,
		rotation: draft.rotation,
		scaleX: draft.scaleX,
		scaleY: draft.scaleY,
		sampling: draft.sampling,
	};
	const pinned = pinTextOrigin(before, {...before, width: size.width, height: size.height});
	return {...draft, style, originX: pinned.originX, originY: pinned.originY, width: size.width, height: size.height};
};

export const setTypeDraft = (draft: TextDraft, focus = false) => {
	emit({
		...state,
		draft,
		error: null,
		fontWarning: fontFaceWarning(draft.style.fontFamily),
		fontPreviewOriginal: null,
		focusToken: focus ? state.focusToken + 1 : state.focusToken,
	});
};

export const clearTypeDraft = () => {
	if (!state.draft && !state.fontPreviewOriginal) return;
	emit({...state, draft: null, fontPreviewOriginal: null});
};

export const replaceTypeText = (value: string, selectionStart: number, selectionEnd: number) => {
	const draft = state.draft;
	if (!draft) return false;
	const style = replaceTextContent(draft.style, value);
	if (!style) return false;
	const next = withMeasuredStyle(draft, style);
	if (!next) {
		setTypeError(textTooLargeMessage());
		return false;
	}
	const count = next.style.content.length;
	emit({
		...state,
		draft: {
			...next,
			selectionStart: Math.max(0, Math.min(selectionStart, count)),
			selectionEnd: Math.max(0, Math.min(selectionEnd, count)),
		},
		error: null,
	});
	return true;
};

export const setTypeSelection = (selectionStart: number, selectionEnd: number) => {
	const draft = state.draft;
	if (!draft) return;
	const count = draft.style.content.length;
	const start = Math.max(0, Math.min(selectionStart, count));
	const end = Math.max(0, Math.min(selectionEnd, count));
	if (draft.selectionStart === Math.min(start, end) && draft.selectionEnd === Math.max(start, end)) return;
	emit({...state, draft: {...draft, selectionStart: Math.min(start, end), selectionEnd: Math.max(start, end)}});
};

const applyToDraft = (style: TextStyle) => {
	const draft = state.draft;
	if (!draft) return false;
	const next = withMeasuredStyle(draft, style);
	if (!next) return false;
	emit({
		...state,
		draft: next,
		fontPreviewOriginal: null,
		fontWarning: fontFaceWarning(style.fontFamily),
		error: null,
	});
	return true;
};

export const previewTypeFont = (name: string) => {
	const draft = state.draft;
	if (!draft || !name) return;
	const original = state.fontPreviewOriginal ?? cloneTextStyle(draft.style);
	const {start, end} = selectionOf(draft);
	const style = setTextFont(original, name, start, end);
	if (!isValidTextStyle(style) || !textFits(style)) return;
	const next = withMeasuredStyle({...draft, style: original}, style);
	if (!next) return;
	emit({...state, fontPreviewOriginal: original, draft: {...next, selectionStart: draft.selectionStart, selectionEnd: draft.selectionEnd}});
};

export const keepTypeFontPreview = () => {
	if (!state.fontPreviewOriginal) return;
	emit({...state, fontPreviewOriginal: null});
};

export const endTypeFontPreview = () => {
	const original = state.fontPreviewOriginal;
	const draft = state.draft;
	if (!original || !draft) {
		if (state.fontPreviewOriginal) emit({...state, fontPreviewOriginal: null});
		return;
	}
	const next = withMeasuredStyle(draft, original);
	emit({...state, fontPreviewOriginal: null, draft: next ?? draft, fontWarning: fontFaceWarning(original.fontFamily)});
};

const openLayer = (layer: LayerNode, caret: number | 'end') => {
	if (layer.kind !== 'text' || layer.content.kind !== 'text') return null;
	const style = styleFromTextContent(layer.content, layer.transform);
	const count = style.content.length;
	const index = caret === 'end' ? count : Math.max(0, Math.min(caret, count));
	const draft: TextDraft = {
		id: draftId(),
		layerId: layer.id,
		originX: layer.transform.originX,
		originY: layer.transform.originY,
		width: layer.transform.width,
		height: layer.transform.height,
		rotation: layer.transform.rotation,
		scaleX: layer.transform.scaleX,
		scaleY: layer.transform.scaleY,
		sampling: layer.transform.sampling,
		style,
		selectionStart: index,
		selectionEnd: index,
		originalStyle: cloneTextStyle(style),
		originalTransform: {...layer.transform},
	};
	return draft;
};

export const editTextLayer = (layer: LayerNode, caret: number | 'end' = 'end') => {
	const draft = openLayer(layer, caret);
	if (!draft) return false;
	setTypeDraft(draft, true);
	return true;
};

export const changeTypeStyle = (
	document: DocumentState,
	activeLayerId: string | null,
	change: (style: TextStyle) => void,
) => {
	if (!state.draft && activeLayerId) {
		const layer = document.layers[activeLayerId];
		if (layer && !layer.locked && layer.kind === 'text' && layer.content.kind === 'text') editTextLayer(layer, 'end');
	}
	if (state.draft) {
		const style = cloneTextStyle(state.draft.style);
		change(style);
		if (!isValidTextStyle(style) || !textFits(style) || !applyToDraft(style)) {
			if (isValidTextStyle(style) && !textFits(style)) setTypeError(textTooLargeMessage());
			return false;
		}
		return true;
	}
	const style = cloneTextStyle(state.defaults);
	change(style);
	style.runs = [];
	style.content = state.defaults.content;
	if (!isValidTextStyle(style)) return false;
	emit({...state, defaults: style, fontWarning: fontFaceWarning(style.fontFamily), error: null});
	return true;
};

export const setTypeSwatchColor = (document: DocumentState, activeLayerId: string | null, color: BrushColor) => {
	setBrushForeground(color);
	const draft = state.draft;
	const range = draft ? selectionOf(draft) : {start: 0, end: 0};
	return changeTypeStyle(document, activeLayerId, (style) => {
		const next = setTextColor(style, color, range.start, range.end);
		style.color = next.color;
		style.runs = next.runs;
	});
};

export const setTypeFace = (document: DocumentState, activeLayerId: string | null, name: string) => {
	const draft = state.draft;
	const range = draft ? selectionOf(draft) : {start: 0, end: 0};
	keepTypeFontPreview();
	return changeTypeStyle(document, activeLayerId, (style) => {
		const next = setTextFont(style, name, range.start, range.end);
		style.fontFamily = next.fontFamily;
		style.runs = next.runs;
	});
};

/** New text starts from the last commit, in the foreground color, with no leftover per-letter styling. */
export const styleForNewText = (): TextStyle => {
	const foreground = getBrushToolSettings().foreground;
	return {
		...cloneTextStyle(state.defaults),
		content: '',
		runs: [],
		boxSize: null,
		color: {r: foreground.r, g: foreground.g, b: foreground.b},
	};
};

export const rememberTypeDefaults = (style: TextStyle) => {
	const next = cloneTextStyle(style);
	next.runs = [];
	next.boxSize = null;
	if (!isValidTextStyle({...next, content: next.content || 'Text'})) return;
	emit({...state, defaults: {...next, content: next.content || state.defaults.content}});
};

export const nudgeStyle = (style: TextStyle, kind: 'tracking' | 'leading-up' | 'leading-down', step: number) => {
	if (kind === 'tracking') style.tracking = Math.min(1000, Math.max(-100, style.tracking + step));
	else if (kind === 'leading-up') style.leading = Math.max(1, lineHeightOf(style) - step);
	else style.leading = Math.min(5000, lineHeightOf(style) + step);
};

export const resetTypeEditorState = () => {
	pendingEditLayerId = null;
	actions = null;
	emit(initial());
};
