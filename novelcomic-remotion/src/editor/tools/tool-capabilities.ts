import {isImplementedTool, type ToolCapability, type ToolRequirement, type ToolSessionContext, type WorkspaceToolId} from './types';
export const resolveToolCapability = (toolId: WorkspaceToolId, context: Pick<ToolSessionContext, 'document' | 'activeLayerId' | 'selectedLayerIds'>, requirements: readonly ToolRequirement[] = []): ToolCapability => {
	for (const requirement of requirements) {
		if (requirement === 'document' && !context.document) return {enabled: false, reason: '没有打开文档'};
		if (requirement === 'active-layer' && !context.activeLayerId) return {enabled: false, reason: '需要活动图层'};
		if (requirement === 'editable-layer') { const layer = context.activeLayerId ? context.document.layers[context.activeLayerId] : undefined; if (!layer) return {enabled: false, reason: '需要活动图层'}; if (!layer.visible) return {enabled: false, reason: '活动图层已隐藏'}; if (layer.locked) return {enabled: false, reason: '活动图层已锁定'}; }
		if (requirement === 'selection' && !context.selectedLayerIds.length && !context.document.selections['active-selection']) return {enabled: false, reason: '需要选择对象'};
		if (requirement === 'implemented' && !isImplementedTool(toolId)) return {enabled: false, reason: '此工具尚未实现'};
	}
	return {enabled: true};
};