import {cloneStatusHint} from './brush/clone-stamp';
import {brushStatusHint, healingStatusHint} from './brush/brush-settings';
import {lassoStatusHint, setLassoKind} from './lasso/lasso-settings';
import {marqueeStatusHint, setMarqueeKind} from './marquee/marquee-settings';
import {BrushToolSession} from './sessions/brush-tool-session';
import {CloneStampToolSession} from './sessions/clone-stamp-tool-session';
import {HandToolSession} from './sessions/hand-tool-session'; import {HealingToolSession} from './sessions/healing-tool-session'; import {LassoToolSession} from './sessions/lasso-tool-session'; import {MarqueeToolSession} from './sessions/marquee-tool-session'; import {MoveToolSession} from './sessions/move-tool-session'; import {UnavailableToolSession} from './sessions/unavailable-tool-session'; import {ZoomToolSession} from './sessions/zoom-tool-session'; import type {ToolDefinition, WorkspaceToolId} from './types';
const unavailable = (id: WorkspaceToolId, label: string, shortcut: string | undefined): ToolDefinition => ({id, label, shortcut, statusHint: `${label} 尚未实现`, requirements: ['document'], cursor: 'not-allowed', createSession: (context) => new UnavailableToolSession(id, context)});
export const TOOL_REGISTRY: readonly ToolDefinition[] = [
	{id: 'move', label: '移动/变换', shortcut: 'V', statusHint: '拖动当前层 · 手柄缩放旋转 · Option 复制 · ⌘ 临时自动选择', requirements: ['document'], cursor: 'default', createSession: (context) => new MoveToolSession(context)},
	{id: 'marquee-rectangle', label: '矩形选框', shortcut: 'M', statusHint: marqueeStatusHint('rectangle'), requirements: ['document'], cursor: 'crosshair', createSession: (context) => new MarqueeToolSession(context, 'marquee-rectangle')},
	{id: 'marquee-ellipse', label: '椭圆选框', statusHint: marqueeStatusHint('ellipse'), requirements: ['document'], cursor: 'crosshair', createSession: (context) => { setMarqueeKind('ellipse'); return new MarqueeToolSession(context, 'marquee-ellipse'); }},
	{id: 'lasso', label: '套索', shortcut: 'L', statusHint: lassoStatusHint('freehand'), requirements: ['document'], cursor: 'crosshair', createSession: (context) => new LassoToolSession(context)},
	{id: 'polygon-lasso', label: '多边形套索', statusHint: lassoStatusHint('polygonal'), requirements: ['document'], cursor: 'crosshair', createSession: (context) => { setLassoKind('polygonal'); return new LassoToolSession(context, 'polygon-lasso'); }},
	{id: 'brush', label: '画笔', shortcut: 'B', statusHint: brushStatusHint(), requirements: ['document'], cursor: 'crosshair', createSession: (context) => new BrushToolSession(context)},
	{id: 'healing', label: '修复画笔', shortcut: 'J', statusHint: healingStatusHint(), requirements: ['document'], cursor: 'crosshair', createSession: (context) => new HealingToolSession(context)},
	{id: 'clone-stamp', label: '仿制图章', shortcut: 'S', statusHint: cloneStatusHint(), requirements: ['document'], cursor: 'crosshair', createSession: (context) => new CloneStampToolSession(context)},
	...([['magic-wand', '魔棒', undefined], ['color-range', '色彩范围', undefined], ['object-select', '对象选择', 'W'], ['select-subject', '选择主体', undefined], ['eraser', '橡皮擦', 'E'], ['blur', '模糊', undefined], ['smudge', '涂抹', undefined], ['liquify', '液化', undefined], ['gradient', '渐变', 'G'], ['eyedropper', '吸管', 'I'], ['shape', '形状', 'U'], ['type', '文字', 'T']] as const).map(([id, label, shortcut]) => unavailable(id, label, shortcut)),
	{id: 'hand', label: '抓手', shortcut: 'H', statusHint: '拖动平移视口 · Space 临时抓手', requirements: ['document'], cursor: 'grab', createSession: (context) => new HandToolSession(context)},
	{id: 'zoom', label: '缩放', shortcut: 'Z', statusHint: '点击围绕光标缩放 · Option 缩小', requirements: ['document'], cursor: 'zoom-in', createSession: (context) => new ZoomToolSession(context)},
];
export const TOOL_REGISTRY_BY_ID = Object.fromEntries(TOOL_REGISTRY.map((definition) => [definition.id, definition])) as Record<WorkspaceToolId, ToolDefinition>;
export const getToolDefinition = (id: WorkspaceToolId) => TOOL_REGISTRY_BY_ID[id];
export const toolShortcuts = Object.fromEntries(TOOL_REGISTRY.flatMap((definition) => definition.shortcut ? [[definition.shortcut.toLowerCase(), definition.id]] : [])) as Record<string, WorkspaceToolId>;
export const validateToolRegistry = () => { const ids = new Set<string>(), shortcuts = new Set<string>(); for (const definition of TOOL_REGISTRY) { if (ids.has(definition.id)) throw new Error(`重复工具 id: ${definition.id}`); ids.add(definition.id); if (definition.shortcut) { const key = definition.shortcut.toLowerCase(); if (shortcuts.has(key)) throw new Error(`重复工具快捷键: ${definition.shortcut}`); shortcuts.add(key); } } return true; };
if (process.env.NODE_ENV !== 'production') validateToolRegistry();