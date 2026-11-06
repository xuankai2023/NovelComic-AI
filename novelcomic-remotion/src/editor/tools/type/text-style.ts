import {DOCUMENT_LIMITS} from '../../document/limits';
import {flattenLayerTree} from '../../document/tree';
import type {DocumentState, LayerNode, LayerTransform, TextLayerContent} from '../../document/types';
import {documentToLayer} from '../coordinates';
import {ancestorLocked, ancestorVisible, placedPoint, toPlaced} from '../move/transform-math';
import type {ToolPoint} from '../types';

/**
 * Text metrics shared with Compositor's LayerTextStyle.
 * Leading is baseline-to-baseline. 0 is Auto, 120% of the font size.
 * Point text has no box; a paragraph box wraps inside `boxSize`.
 * Padding is the same for both, so turning one into the other does not move the letters.
 */
export const TEXT_PADDING = 12;
export const MAX_TEXT_CHARS = 100_000;
export const MAX_TEXT_PIXELS = 200_000_000;
export const MAX_TEXT_MEGAPIXELS = MAX_TEXT_PIXELS / 1_000_000;

export const TYPE_FONTS = [
	'Helvetica',
	'Helvetica Neue',
	'Arial',
	'Arial Black',
	'Verdana',
	'Tahoma',
	'Trebuchet MS',
	'Gill Sans',
	'Futura',
	'Avenir',
	'Times New Roman',
	'Times',
	'Georgia',
	'Palatino',
	'Garamond',
	'Courier New',
	'Courier',
	'Menlo',
	'Monaco',
	'Impact',
	'system-ui',
	'sans-serif',
	'serif',
	'monospace',
] as const;

export type TextAlign = 'left' | 'center' | 'right';
export type TextRgb = {r: number; g: number; b: number};
export type TextRun = {start: number; end: number; fontFamily?: string; color?: TextRgb};
export type TextStyle = {
	content: string;
	fontFamily: string;
	fontSize: number;
	color: TextRgb;
	align: TextAlign;
	/** Extra space between letters, in layer pixels. Compositor's tracking. */
	tracking: number;
	/** 0 is Auto. Otherwise baseline-to-baseline, in layer pixels. */
	leading: number;
	boxSize: {width: number; height: number} | null;
	runs: TextRun[];
};

export type TextLayoutLine = {
	start: number;
	end: number;
	text: string;
	x: number;
	width: number;
	baseline: number;
};

export type TextLayout = {
	width: number;
	height: number;
	lineHeight: number;
	descent: number;
	padding: number;
	lines: TextLayoutLine[];
	overflow: boolean;
};

type GlyphMeasurer = {
	width: (text: string, fontFamily: string, fontSize: number) => number;
	descent: (fontFamily: string, fontSize: number) => number;
};

const approximateMeasurer: GlyphMeasurer = {
	width: (text, _family, size) => Array.from(text).reduce((sum, ch) => sum + (ch.trim() ? size * 0.5 : size * 0.33), 0),
	descent: (_family, size) => size * 0.2,
};

const fontSpec = (family: string, size: number) => `${size}px "${family.replace(/"/g, '')}", sans-serif`;

const createMeasurer = (): GlyphMeasurer => {
	if (typeof document === 'undefined') return approximateMeasurer;
	try {
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d');
		if (!ctx) return approximateMeasurer;
		return {
			width(text, family, size) {
				ctx.font = fontSpec(family, size);
				return ctx.measureText(text).width;
			},
			descent(family, size) {
				ctx.font = fontSpec(family, size);
				const metrics = ctx.measureText('Hg');
				return metrics.actualBoundingBoxDescent || size * 0.2;
			},
		};
	} catch {
		return approximateMeasurer;
	}
};

let measurer = createMeasurer();

/** Tests pin a deterministic measurer. Pass null to restore the default. */
export const setTextMeasurer = (next: GlyphMeasurer | null) => {
	measurer = next ?? createMeasurer();
};

const finite = (value: number) => Number.isFinite(value);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const sameTextColor = (left: TextRgb | undefined, right: TextRgb | undefined) =>
	!!left && !!right && left.r === right.r && left.g === right.g && left.b === right.b;

export const lineHeightOf = (style: Pick<TextStyle, 'fontSize' | 'leading'>) =>
	style.leading > 0 ? style.leading : style.fontSize * 1.2;

export const defaultTextStyle = (): TextStyle => ({
	content: 'Text',
	fontFamily: 'Helvetica',
	fontSize: 72,
	color: {r: 0, g: 0, b: 0},
	align: 'left',
	tracking: 0,
	leading: 0,
	boxSize: null,
	runs: [],
});

export const cloneTextStyle = (style: TextStyle): TextStyle => ({
	...style,
	color: {...style.color},
	boxSize: style.boxSize ? {...style.boxSize} : null,
	runs: style.runs.map((run) => ({...run, color: run.color ? {...run.color} : undefined})),
});

export const textTooLargeMessage = () =>
	`That text box exceeds the ${DOCUMENT_LIMITS.maxWidth}-pixel or ${MAX_TEXT_MEGAPIXELS}-megapixel limit.`;

export const boxIsValid = (box: {width: number; height: number} | null) => {
	if (!box) return true;
	const {width, height} = box;
	if (!finite(width) || !finite(height)) return false;
	if (width < 16 || height < 16 || width > DOCUMENT_LIMITS.maxWidth || height > DOCUMENT_LIMITS.maxHeight) return false;
	if (width > Number.MAX_SAFE_INTEGER / height) return false;
	return width * height <= MAX_TEXT_PIXELS;
};

const runsAreValid = (style: TextStyle) => {
	let end = 0;
	for (const run of style.runs) {
		if (!Number.isInteger(run.start) || !Number.isInteger(run.end) || run.start < end || run.end <= run.start) return false;
		if (run.end > style.content.length) return false;
		if (run.fontFamily !== undefined && (!run.fontFamily || run.fontFamily.length > 200 || /[\r\n]/.test(run.fontFamily))) return false;
		if (run.color && ![run.color.r, run.color.g, run.color.b].every((channel) => finite(channel) && channel >= 0 && channel <= 255)) return false;
		if (!run.fontFamily && !run.color) return false;
		end = run.end;
	}
	return true;
};

export const isValidTextStyle = (style: TextStyle) =>
	typeof style.content === 'string' &&
	style.content.length <= MAX_TEXT_CHARS &&
	typeof style.fontFamily === 'string' &&
	style.fontFamily.length > 0 &&
	style.fontFamily.length <= 200 &&
	!/[\r\n]/.test(style.fontFamily) &&
	finite(style.fontSize) &&
	style.fontSize >= 1 &&
	style.fontSize <= 2000 &&
	[style.color.r, style.color.g, style.color.b].every((channel) => finite(channel) && channel >= 0 && channel <= 255) &&
	(style.align === 'left' || style.align === 'center' || style.align === 'right') &&
	finite(style.tracking) &&
	style.tracking >= -100 &&
	style.tracking <= 1000 &&
	finite(style.leading) &&
	style.leading >= 0 &&
	style.leading <= 5000 &&
	boxIsValid(style.boxSize) &&
	runsAreValid(style);

/** Point text grows with what was typed. A box that cannot be stored is rejected before it becomes a layer. */
export const textFits = (style: TextStyle) => {
	if (!isValidTextStyle(style)) return false;
	if (style.boxSize) return true;
	return boxIsValid(measurePointText(style));
};

export const fontFaceWarning = (family: string) => {
	if (TYPE_FONTS.includes(family as (typeof TYPE_FONTS)[number])) return null;
	if (typeof document !== 'undefined' && document.fonts?.check) {
		try {
			if (document.fonts.check(`16px "${family.replace(/"/g, '')}"`)) return null;
		} catch {
			/* A browser that cannot check fonts still draws the fallback stack. */
		}
	}
	return `找不到字体“${family}”，将改用系统无衬线体。`;
};

const charCount = (text: string) => Array.from(text).length;

const advance = (text: string, family: string, size: number, tracking: number) => {
	if (!text) return 0;
	return measurer.width(text, family, size) + tracking * Math.max(0, charCount(text) - 1);
};

export const fontAt = (style: TextStyle, index: number) => {
	const run = style.runs.find((item) => item.fontFamily && item.start <= index && index < item.end);
	return run?.fontFamily ?? style.fontFamily;
};

export const colorAt = (style: TextStyle, index: number): TextRgb => {
	const run = style.runs.find((item) => item.color && item.start <= index && index < item.end);
	return run?.color ?? style.color;
};

/** The one face covering the range, or null when it is empty or uses more than one. */
export const uniformFont = (style: TextStyle, start: number, end: number) => {
	const from = clamp(Math.trunc(start), 0, style.content.length);
	const to = clamp(Math.trunc(end), from, style.content.length);
	if (to <= from) return null;
	const face = fontAt(style, from);
	for (let index = from; index < to; index += 1) if (fontAt(style, index) !== face) return null;
	return face;
};

const unitFonts = (style: TextStyle) => {
	const fonts = Array.from({length: style.content.length}, () => style.fontFamily);
	for (const run of style.runs) {
		if (!run.fontFamily) continue;
		for (let index = run.start; index < run.end && index < fonts.length; index += 1) fonts[index] = run.fontFamily;
	}
	return fonts;
};

const unitColors = (style: TextStyle) => {
	const colors = Array.from({length: style.content.length}, () => style.color);
	for (const run of style.runs) {
		if (!run.color) continue;
		for (let index = run.start; index < run.end && index < colors.length; index += 1) colors[index] = run.color;
	}
	return colors;
};

const coalesce = (style: TextStyle, fonts: string[], colors: TextRgb[]): TextRun[] => {
	const runs: TextRun[] = [];
	for (let index = 0; index < fonts.length; index += 1) {
		const fontFamily = fonts[index] !== style.fontFamily ? fonts[index] : undefined;
		const color = sameTextColor(colors[index], style.color) ? undefined : colors[index];
		if (!fontFamily && !color) continue;
		const last = runs[runs.length - 1];
		if (last && last.end === index && last.fontFamily === fontFamily && sameTextColor(last.color, color)) {
			last.end += 1;
			continue;
		}
		runs.push({start: index, end: index + 1, ...(fontFamily ? {fontFamily} : {}), ...(color ? {color: {...color}} : {})});
	}
	return runs;
};

const rangeOf = (style: TextStyle, start: number, end: number) => {
	const from = clamp(Math.trunc(start), 0, style.content.length);
	const to = clamp(Math.trunc(end), from, style.content.length);
	return {from, to};
};

/** An empty range, or one covering everything, changes the whole text and clears per-letter faces. */
export const setTextFont = (style: TextStyle, name: string, start: number, end: number): TextStyle => {
	if (!name || name.length > 200 || /[\r\n]/.test(name)) return style;
	const {from, to} = rangeOf(style, start, end);
	const fonts = unitFonts(style);
	const colors = unitColors(style);
	if (from === to || (from === 0 && to === style.content.length)) fonts.fill(name);
	else for (let index = from; index < to; index += 1) fonts[index] = name;
	const fontFamily = fonts.every((font) => font === fonts[0]) ? fonts[0] ?? name : style.fontFamily;
	const next = {...style, fontFamily};
	return {...next, runs: coalesce(next, fonts, colors)};
};

export const setTextColor = (style: TextStyle, color: TextRgb, start: number, end: number): TextStyle => {
	const safe = {r: clamp(Math.round(color.r), 0, 255), g: clamp(Math.round(color.g), 0, 255), b: clamp(Math.round(color.b), 0, 255)};
	const {from, to} = rangeOf(style, start, end);
	const fonts = unitFonts(style);
	const colors = unitColors(style);
	if (from === to || (from === 0 && to === style.content.length)) colors.fill(safe);
	else for (let index = from; index < to; index += 1) colors[index] = safe;
	const base = colors.every((item) => sameTextColor(item, colors[0])) ? colors[0] ?? safe : style.color;
	const next = {...style, color: {...base}};
	return {...next, runs: coalesce(next, fonts, colors)};
};

const diffReplace = (before: string, after: string) => {
	let start = 0;
	const shared = Math.min(before.length, after.length);
	while (start < shared && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
	let endBefore = before.length;
	let endAfter = after.length;
	while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
		endBefore -= 1;
		endAfter -= 1;
	}
	return {start, removed: endBefore - start, insert: after.slice(start, endAfter)};
};

/** New letters take the face and color of the letter before them, the way typing does. */
export const replaceTextContent = (style: TextStyle, next: string): TextStyle | null => {
	if (next.length > MAX_TEXT_CHARS) return null;
	if (next === style.content) return style;
	if (!style.runs.length) {
		const updated = {...style, content: next};
		return isValidTextStyle(updated) ? updated : null;
	}
	const change = diffReplace(style.content, next);
	const fonts = unitFonts(style);
	const colors = unitColors(style);
	const inheritFont = change.start > 0 ? fonts[change.start - 1]! : fonts[change.start] ?? style.fontFamily;
	const inheritColor = change.start > 0 ? colors[change.start - 1]! : colors[change.start] ?? style.color;
	fonts.splice(change.start, change.removed, ...Array.from({length: change.insert.length}, () => inheritFont));
	colors.splice(change.start, change.removed, ...Array.from({length: change.insert.length}, () => inheritColor));
	const updated = {...style, content: next, runs: coalesce(style, fonts, colors)};
	return isValidTextStyle(updated) ? updated : null;
};

const measureSlice = (style: TextStyle, text: string) => advance(text, style.fontFamily, style.fontSize, style.tracking);

const breakLines = (style: TextStyle, maxWidth: number) => {
	const lines: Array<{start: number; end: number; text: string; width: number}> = [];
	const content = style.content;
	let index = 0;
	const widthOf = (text: string) => measureSlice(style, text);
	while (index <= content.length && lines.length < 10_000) {
		const newline = content.indexOf('\n', index);
		const paraEnd = newline === -1 ? content.length : newline;
		if (index === paraEnd) lines.push({start: index, end: index, text: '', width: 0});
		let cursor = index;
		while (cursor < paraEnd && lines.length < 10_000) {
			let fit = cursor;
			let lastBreak = -1;
			for (let mark = cursor + 1; mark <= paraEnd; mark += 1) {
				const slice = content.slice(cursor, mark);
				if (widthOf(slice) > maxWidth && mark > cursor + 1) break;
				fit = mark;
				if (/\s/.test(content.charAt(mark - 1))) lastBreak = mark;
			}
			if (fit === cursor) fit = Math.min(paraEnd, cursor + 1);
			const end = lastBreak > cursor && fit < paraEnd ? lastBreak : fit;
			const text = content.slice(cursor, end);
			lines.push({start: cursor, end, text, width: widthOf(text)});
			if (end <= cursor) break;
			cursor = end;
		}
		if (newline === -1) break;
		index = paraEnd + 1;
		if (index === content.length) {
			lines.push({start: index, end: index, text: '', width: 0});
			break;
		}
	}
	if (!lines.length) lines.push({start: 0, end: 0, text: '', width: 0});
	return lines;
};

export const layoutText = (style: TextStyle, box: {width: number; height: number}, wrap: boolean): TextLayout => {
	const lineHeight = lineHeightOf(style);
	const descent = measurer.descent(style.fontFamily, style.fontSize);
	const inner = Math.max(1, (wrap ? box.width : 100_000) - TEXT_PADDING * 2);
	const broken = breakLines(style, inner);
	const lines: TextLayoutLine[] = broken.map((line, index) => {
		const room = Math.max(0, box.width - TEXT_PADDING * 2);
		const x =
			style.align === 'center'
				? TEXT_PADDING + (room - line.width) / 2
				: style.align === 'right'
					? TEXT_PADDING + room - line.width
					: TEXT_PADDING;
		return {...line, x, baseline: TEXT_PADDING + lineHeight - descent + index * lineHeight};
	});
	const last = lines[lines.length - 1];
	const overflow = Boolean(wrap && last && last.baseline + descent > box.height + 0.5);
	return {width: box.width, height: box.height, lineHeight, descent, padding: TEXT_PADDING, lines, overflow};
};

/** How big point text is: what it measures, plus padding, plus a caret's worth of width. */
export const measurePointText = (style: TextStyle) => {
	const probe = layoutText(style, {width: 100_000, height: 100_000}, false);
	const measuredWidth = probe.lines.reduce((max, line) => Math.max(max, line.width), 0);
	const textHeight = Math.max(probe.lineHeight, probe.lines.length * probe.lineHeight);
	return {
		width: Math.max(16, Math.ceil(measuredWidth + TEXT_PADDING * 2 + style.fontSize * 0.1)),
		height: Math.max(16, Math.ceil(textHeight + TEXT_PADDING * 2)),
	};
};

/**
 * A click puts the first baseline on the pointer.
 * The line's extra leading sits above the letters, so the baseline is one descent up from the bottom of the line.
 */
export const pointTextOrigin = (point: ToolPoint, style: TextStyle) => {
	const size = measurePointText(style);
	const descent = measurer.descent(style.fontFamily, style.fontSize);
	const baseline = TEXT_PADDING + lineHeightOf(style) - descent;
	return {originX: point.x - TEXT_PADDING, originY: point.y - baseline, width: size.width, height: size.height};
};

/** Keep the transformed top-left where it was when point text grows. */
export const pinTextOrigin = (before: LayerTransform, next: LayerTransform): LayerTransform => {
	const oldPlaced = toPlaced(before);
	const nextPlaced = toPlaced(next);
	const anchor = placedPoint(oldPlaced, {x: 0, y: 0});
	const moved = placedPoint(nextPlaced, {x: 0, y: 0});
	return {...next, originX: next.originX + anchor.x - moved.x, originY: next.originY + anchor.y - moved.y};
};

export const caretIndexAt = (style: TextStyle, width: number, height: number, localX: number, localY: number) => {
	const layout = layoutText(style, {width, height}, style.boxSize != null);
	if (!layout.lines.length) return 0;
	const raw = Math.floor((localY - TEXT_PADDING) / layout.lineHeight);
	const line = layout.lines[clamp(raw, 0, layout.lines.length - 1)]!;
	if (localX <= line.x) return line.start;
	let cursor = line.x;
	let offset = line.start;
	const chars = Array.from(line.text);
	for (let index = 0; index < chars.length; index += 1) {
		const ch = chars[index]!;
		const widthOf = measurer.width(ch, fontAt(style, offset), style.fontSize) + (index < chars.length - 1 ? style.tracking : 0);
		if (localX < cursor + widthOf / 2) return offset;
		cursor += widthOf;
		offset += ch.length;
	}
	return line.end;
};

export const layerNameForText = (content: string) => {
	const flattened = content.split(/\s+/).filter(Boolean).join(' ');
	return flattened ? flattened.slice(0, 40) : 'Text';
};

export const isCompositorText = (content: TextLayerContent) => content.leading !== undefined || content.boxSize != null;

export const styleFromTextContent = (content: TextLayerContent, size: {width: number; height: number}): TextStyle => {
	const paragraph = content.boxSize != null || (content.leading === undefined && size.width >= 16 && size.height >= 16);
	const leading =
		content.leading ??
		(Math.abs(content.lineHeight - 1.2) < 0.001 ? 0 : clamp(content.fontSize * content.lineHeight, 0, 5000));
	return {
		content: content.text,
		fontFamily: content.fontFamily || 'Helvetica',
		fontSize: clamp(content.fontSize, 1, 2000),
		color: {r: content.color.r, g: content.color.g, b: content.color.b},
		align: content.align,
		tracking: content.letterSpacing,
		leading,
		boxSize: paragraph ? {width: Math.round(size.width), height: Math.round(size.height)} : null,
		runs: (content.runs ?? []).flatMap((run) => {
			if (!Number.isInteger(run.start) || !Number.isInteger(run.end) || run.end <= run.start) return [];
			return [
				{
					start: run.start,
					end: run.end,
					...(run.fontFamily ? {fontFamily: run.fontFamily} : {}),
					...(run.color ? {color: {r: run.color.r, g: run.color.g, b: run.color.b}} : {}),
				},
			];
		}),
	};
};

export const textContentFromStyle = (style: TextStyle): TextLayerContent => {
	const runs = style.runs.map((run) => ({
		start: run.start,
		end: run.end,
		...(run.fontFamily ? {fontFamily: run.fontFamily} : {}),
		...(run.color ? {color: {r: run.color.r, g: run.color.g, b: run.color.b, a: 1}} : {}),
	}));
	return {
		kind: 'text',
		text: style.content,
		fontFamily: style.fontFamily,
		fontSize: style.fontSize,
		color: {r: style.color.r, g: style.color.g, b: style.color.b, a: 1},
		align: style.align,
		lineHeight: style.leading > 0 ? style.leading / style.fontSize : 1.2,
		letterSpacing: style.tracking,
		leading: style.leading,
		...(style.boxSize ? {boxSize: {width: style.boxSize.width, height: style.boxSize.height}} : {}),
		...(runs.length ? {runs} : {}),
	};
};

export const paintCompositorText = (
	ctx: CanvasRenderingContext2D,
	content: TextLayerContent,
	width: number,
	height: number,
) => {
	const style = styleFromTextContent(content, {width, height});
	const layout = layoutText(style, {width, height}, style.boxSize != null);
	ctx.save();
	ctx.beginPath();
	ctx.rect(0, 0, width, height);
	ctx.clip();
	ctx.textBaseline = 'alphabetic';
	for (const line of layout.lines) {
		let x = line.x;
		let offset = line.start;
		const chars = Array.from(line.text);
		for (let index = 0; index < chars.length; index += 1) {
			const ch = chars[index]!;
			const family = fontAt(style, offset);
			const color = colorAt(style, offset);
			ctx.font = fontSpec(family, style.fontSize);
			ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},1)`;
			ctx.fillText(ch, x, line.baseline);
			x += measurer.width(ch, family, style.fontSize);
			if (index < chars.length - 1) x += style.tracking;
			offset += ch.length;
		}
	}
	ctx.restore();
};

const soloVisible = (document: DocumentState, layer: LayerNode) => {
	const solos = Object.values(document.layers).filter((item) => item.solo);
	if (!solos.length) return true;
	if (layer.solo) return true;
	let parentId = layer.parentId;
	while (parentId) {
		if (document.layers[parentId]?.solo) return true;
		parentId = document.layers[parentId]?.parentId ?? null;
	}
	return false;
};

/** Topmost visible, unlocked text layer whose box contains the document point. */
export const topTextLayerAt = (document: DocumentState, point: ToolPoint): LayerNode | null => {
	const layers = flattenLayerTree(document);
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const layer = layers[index]!;
		if (layer.kind !== 'text' || layer.content.kind !== 'text') continue;
		if (!ancestorVisible(document, layer) || ancestorLocked(document, layer) || !soloVisible(document, layer)) continue;
		const local = documentToLayer(point, document, layer.id);
		if (!local) continue;
		if (local.x >= -0.5 && local.y >= -0.5 && local.x <= layer.transform.width + 0.5 && local.y <= layer.transform.height + 0.5) return layer;
	}
	return null;
};
