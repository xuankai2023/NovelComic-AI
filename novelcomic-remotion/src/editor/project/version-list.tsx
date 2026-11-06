'use client';

import React from 'react';
import {useProjectContext} from './project-context';

const reasonLabels: Record<string, string> = {
	create: '创建',
	command: '编辑提交',
	autosave: '自动保存',
	manual: '手动保存',
	restore: '恢复版本',
	import: '导入',
};

export const VersionList: React.FC = () => {
	const {snapshots, currentSnapshot, restoreSnapshot, deleteSnapshot, downloadBackup} = useProjectContext();

	return (
		<div className="flex max-h-[58vh] flex-col gap-2 overflow-y-auto pr-1">
			{snapshots.length === 0 ? (
				<div className="text-editor-starter-text-muted rounded-xl border border-white/10 p-4 text-sm">还没有版本。</div>
			) : null}
			{[...snapshots].reverse().map((snapshot) => {
				const isCurrent = snapshot.snapshotId === currentSnapshot?.snapshotId;
				return (
					<div key={snapshot.snapshotId} className="rounded-xl border border-white/10 bg-black/10 p-3">
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<div className="flex items-center gap-2 text-sm font-semibold">
									<span>Revision {snapshot.revision}</span>
									{isCurrent ? <span className="rounded bg-editor-starter-accent/20 px-1.5 py-0.5 text-[11px] text-editor-starter-accent">当前</span> : null}
								</div>
								<div className="text-editor-starter-text-muted mt-1 text-xs">
									{new Date(snapshot.savedAt).toLocaleString()} · {reasonLabels[snapshot.reason] ?? snapshot.reason}
								</div>
								<div className="text-editor-starter-text-muted mt-1 truncate font-mono text-[11px]">hash {snapshot.contentHash.slice(0, 8)} · 渲染引用未记录</div>
							</div>
							<div className="flex shrink-0 gap-1">
								<button type="button" className="rounded-lg border border-white/10 px-2 py-1 text-xs hover:bg-white/10" onClick={() => downloadBackup(snapshot)}>备份</button>
								{!isCurrent ? <button type="button" className="rounded-lg border border-white/10 px-2 py-1 text-xs hover:bg-white/10" onClick={() => void restoreSnapshot(snapshot.snapshotId)}>恢复</button> : null}
								{!isCurrent && snapshot.reason !== 'restore' && snapshot.reason !== 'manual' ? <button type="button" className="rounded-lg border border-red-300/20 px-2 py-1 text-xs text-red-200 hover:bg-red-300/10" onClick={() => void deleteSnapshot(snapshot.snapshotId)}>删除</button> : null}
							</div>
						</div>
					</div>
				);
			})}
		</div>
	);
};
