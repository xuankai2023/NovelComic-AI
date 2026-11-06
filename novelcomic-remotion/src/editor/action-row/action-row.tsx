import {Toolbar} from '@heroui/react';
import {ChevronDown} from 'lucide-react';
import {useTranslations} from 'next-intl';
import React from 'react';
import {
	FEATURE_CANVAS_ZOOM_CONTROLS,
	FEATURE_EXPORT_BUTTON,
	FEATURE_REDO_BUTTON,
	FEATURE_UNDO_BUTTON,
} from '../flags';
import {CanvasZoomControls} from './canvas-zoom-controls';
import {ExportButton} from './export-button';
import {MoreMenu} from './more-menu';
import {RedoButton} from './redo-button';
import {TaskIconButton} from './tasks-indicator/task-icon-button';
import {ToolSelection} from './tool-selection';
import {
	actionToolbarDividerClass,
	actionToolbarSectionClass,
} from './toolbar-styles';
import {UndoButton} from './undo-button';

export const ActionRow: React.FC<{
	sidebarWidthPercent: number;
	sidebarCollapsed: boolean;
}> = ({sidebarWidthPercent, sidebarCollapsed}) => {
	const t = useTranslations('editor.actionRow.toolbar');
	return (
		<div className="ae-action-row bg-editor-starter-panel flex w-full items-stretch">
			<div
				className="flex shrink-0 overflow-hidden border-r border-black bg-[#0f0f12]"
				style={{width: sidebarCollapsed ? 0 : `${sidebarWidthPercent}%`}}
				aria-hidden={sidebarCollapsed}
			>
				<div className="flex w-[52px] shrink-0 items-center justify-center border-r border-white/5 bg-[#0f0f12]">
					<span className="flex size-8 items-center justify-center rounded-lg bg-[#1a1a1f] text-xs font-semibold text-white/62">
						OC
					</span>
				</div>
				<div className="flex min-w-0 flex-1 items-center bg-[#151518] px-3 py-3">
					<div
						className="flex min-w-0 items-center gap-3 text-sm font-semibold text-white"
						title="user4055874187868"
					>
						<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#7357ff] text-base font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]">
							U
						</span>
						<span className="min-w-0 truncate text-base">
							user4055874187868
						</span>
						<ChevronDown className="size-4 shrink-0 text-white/62" />
					</div>
				</div>
			</div>
			<div className="relative flex min-w-0 flex-1 items-center justify-end px-3 py-3">
				<div className="pointer-events-none absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center">
					<Toolbar
						aria-label={t('centeredEditorActions')}
						className="pointer-events-auto !flex items-center gap-3"
					>
						<ToolSelection />
						{FEATURE_CANVAS_ZOOM_CONTROLS ? <CanvasZoomControls /> : null}
						{FEATURE_UNDO_BUTTON || FEATURE_REDO_BUTTON ? (
							<div
								role="group"
								aria-label={t('historyActions')}
								className={actionToolbarSectionClass}
							>
								{FEATURE_UNDO_BUTTON && <UndoButton />}
								{FEATURE_UNDO_BUTTON && FEATURE_REDO_BUTTON ? (
									<div className={actionToolbarDividerClass}></div>
								) : null}
								{FEATURE_REDO_BUTTON && <RedoButton />}
							</div>
						) : null}
					</Toolbar>
				</div>
				<Toolbar
					aria-label={t('rightEditorActions')}
					className="!flex shrink-0 items-center gap-2"
				>
					<TaskIconButton />
					{FEATURE_EXPORT_BUTTON ? <ExportButton /> : null}
					<MoreMenu />
				</Toolbar>
			</div>
		</div>
	);
};
