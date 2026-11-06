'use client';

import React, {useRef, useState} from 'react';
import {useProjectContext} from './project-context';
import {VersionList} from './version-list';
import {normalizeUndoableState} from '../state/normalize-undoable-state';
import type {UndoableState} from '../state/types';

type ProjectListPanelProps = {
	modal?: boolean;
	initialView?: 'projects' | 'versions';
};

const extractState = (value: unknown): UndoableState | null => {
	if (!value || typeof value !== 'object') return null;
	const candidate = value as Record<string, unknown>;
	const possible = candidate.state ?? (candidate.snapshot as Record<string, unknown> | undefined)?.state ?? candidate.project;
	const state = (possible && typeof possible === 'object' ? possible : value) as Partial<UndoableState>;
	if (!Array.isArray(state.tracks) || !state.items || !state.assets || typeof state.fps !== 'number') return null;
	return normalizeUndoableState(state as UndoableState);
};

export const ProjectListPanel: React.FC<ProjectListPanelProps> = ({modal = false, initialView = 'projects'}) => {
	const context = useProjectContext();
	const {projects, activeProject, migrationFailure, readOnlyReason, saveError} = context;
	const [view, setView] = useState(initialView);
	const [name, setName] = useState('未命名动态漫画');
	const [busy, setBusy] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);

	const run = async (action: () => Promise<unknown>) => {
		setBusy(true);
		try { await action(); } finally { setBusy(false); }
	};

	const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = '';
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const state = extractState(JSON.parse(String(reader.result)));
				if (!state) throw new Error('工程备份格式无效');
				void run(async () => {
					if (activeProject) await context.importState(state);
					else {
						const created = await context.createProject(file.name.replace(/\.json$/i, '') || '导入工程');
						if (created) await context.importState(state);
					}
				});
			} catch (error) { window.alert(error instanceof Error ? error.message : '工程备份读取失败'); }
		};
		reader.onerror = () => window.alert('工程备份读取失败');
		reader.readAsText(file);
	};

	return (
		<div className={modal ? 'fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6' : 'flex min-h-screen w-full items-center justify-center bg-editor-starter-bg p-6'}>
			<div className="bg-editor-starter-panel text-editor-starter-text flex max-h-[90vh] w-full max-w-4xl flex-col gap-5 overflow-hidden rounded-2xl border border-white/10 p-6 shadow-2xl">
				<div className="flex items-center justify-between gap-4">
					<div>
						<div className="text-lg font-semibold">NovelComic 工程</div>
						<div className="text-editor-starter-text-muted mt-1 text-xs">工程存储、自动保存与版本恢复</div>
					</div>
					{modal ? <button type="button" className="rounded-lg border border-white/10 px-3 py-1.5 text-sm hover:bg-white/10" onClick={initialView === 'versions' ? context.closeVersionList : context.closeProjectList}>关闭</button> : null}
					{activeProject && context.isReadOnly ? <button type="button" className="rounded-lg border border-amber-300/30 px-3 py-1.5 text-sm text-amber-100 hover:bg-amber-300/10" onClick={() => context.downloadBackup()}>下载当前备份</button> : null}
				</div>
				{readOnlyReason ? <div className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">只读/恢复模式：{readOnlyReason}</div> : null}
				{migrationFailure ? <div className="flex items-center justify-between gap-3 rounded-xl border border-red-300/30 bg-red-300/10 p-3 text-sm text-red-100"><span>旧工程迁移失败，原始 JSON 仍已保留。</span><button type="button" className="rounded-lg border border-white/20 px-3 py-1.5" onClick={context.downloadMigrationBackup}>下载原始备份</button></div> : null}
				{saveError ? <div className="rounded-xl border border-red-300/20 bg-red-300/10 p-3 text-sm text-red-100">{saveError}</div> : null}
				<div className="flex items-center gap-2 border-b border-white/10 pb-3">
					<button type="button" className={view === 'projects' ? 'rounded-lg bg-editor-starter-accent px-3 py-1.5 text-sm' : 'rounded-lg px-3 py-1.5 text-sm hover:bg-white/10'} onClick={() => setView('projects')}>工程列表</button>
					{activeProject ? <button type="button" className={view === 'versions' ? 'rounded-lg bg-editor-starter-accent px-3 py-1.5 text-sm' : 'rounded-lg px-3 py-1.5 text-sm hover:bg-white/10'} onClick={() => setView('versions')}>版本列表</button> : null}
				</div>
				{view === 'versions' && activeProject ? <VersionList /> : (
					<>
						<div className="flex flex-wrap items-center gap-2">
							<input value={name} onChange={(event) => setName(event.target.value)} className="bg-editor-starter-inset min-w-[220px] flex-1 rounded-lg border border-white/10 px-3 py-2 text-sm outline-none" placeholder="工程名称" />
							<button type="button" disabled={busy || !name.trim()} className="rounded-lg bg-editor-starter-accent px-3 py-2 text-sm disabled:opacity-50" onClick={() => void run(() => context.createProject(name.trim()))}>新建工程</button>
							<button type="button" disabled={busy} className="rounded-lg border border-white/10 px-3 py-2 text-sm disabled:opacity-50" onClick={() => fileRef.current?.click()}>导入 JSON 备份</button>
							<input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImport} />
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto">
							{projects.length === 0 ? <div className="text-editor-starter-text-muted rounded-xl border border-dashed border-white/10 p-8 text-center text-sm">还没有工程，请新建一个工程开始。</div> : <div className="grid gap-3 md:grid-cols-2">{projects.map((project) => (
								<div key={project.projectId} className={`rounded-xl border p-4 ${project.projectId === activeProject?.projectId ? 'border-editor-starter-accent/60 bg-editor-starter-accent/10' : 'border-white/10'}`}>
									<div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate font-semibold">{project.name}</div><div className="text-editor-starter-text-muted mt-1 text-xs">revision {project.currentRevision} · {new Date(project.lastOpenedAt).toLocaleString()}</div></div>{project.archived ? <span className="rounded bg-white/10 px-2 py-1 text-[11px]">已归档</span> : null}</div>
									<div className="mt-3 flex flex-wrap gap-1.5"><button type="button" disabled={project.archived || busy} className="rounded-lg bg-editor-starter-accent px-2.5 py-1.5 text-xs disabled:opacity-50" onClick={() => void run(() => context.openProject(project.projectId))}>打开</button><button type="button" className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs" onClick={() => { const next = window.prompt('新的工程名称', project.name); if (next?.trim()) void run(() => context.renameProject(project.projectId, next.trim())); }}>重命名</button><button type="button" className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs" onClick={() => { const next = window.prompt('复制后的工程名称', `${project.name} 副本`); if (next?.trim()) void run(() => context.duplicateProject(project.projectId, next.trim())); }}>复制</button>{project.archived ? <button type="button" className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs" onClick={() => void run(() => context.restoreProject(project.projectId))}>恢复归档</button> : <button type="button" className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs" onClick={() => void run(() => context.archiveProject(project.projectId))}>归档</button>}<button type="button" className="rounded-lg border border-red-300/20 px-2.5 py-1.5 text-xs text-red-100" onClick={() => { if (window.confirm(`确定删除“${project.name}”及其版本吗？`)) void run(() => context.deleteProject(project.projectId)); }}>删除</button></div>
								</div>
							))}</div>}
						</div>
					</>
				)}
			</div>
		</div>
	);
};
