'use client';

import React from 'react';
import {useProjectContext} from './project-context';

const labels = {
	idle: '未打开工程',
	dirty: '有未保存修改',
	saving: '保存中…',
	saved: '已保存',
	'save-error': '保存失败',
	recovery: '待恢复草稿',
	readonly: '只读模式',
} as const;

export const ProjectStatusBar: React.FC = () => {
	const {activeProject, saveStatus, saveError, currentSnapshot, openProjectList, openVersionList, retrySave, downloadBackup} = useProjectContext();
	if (!activeProject) return null;

	return (
		<div className="pointer-events-auto absolute top-3 left-3 z-10 flex max-w-[min(70%,600px)] items-center gap-2 rounded-xl border border-white/10 bg-black/55 px-3 py-2 text-xs shadow-lg backdrop-blur">
			<div className="min-w-0">
				<div className="truncate font-semibold">{activeProject.name}</div>
				<div className="text-white/60">Revision {currentSnapshot?.revision ?? activeProject.currentRevision} · {labels[saveStatus]}</div>
			</div>
			<button type="button" className="rounded-lg border border-white/10 px-2 py-1 hover:bg-white/10" onClick={openProjectList}>工程</button>
			<button type="button" className="rounded-lg border border-white/10 px-2 py-1 hover:bg-white/10" onClick={openVersionList}>版本</button>
			{saveStatus === 'save-error' ? <button type="button" className="rounded-lg border border-amber-200/30 px-2 py-1 text-amber-100 hover:bg-amber-200/10" onClick={() => void retrySave()}>重试</button> : null}
			{saveStatus === 'readonly' ? <button type="button" className="rounded-lg border border-white/10 px-2 py-1 hover:bg-white/10" onClick={() => downloadBackup()}>下载备份</button> : null}
			{saveError ? <span className="sr-only">{saveError}</span> : null}
		</div>
	);
};
