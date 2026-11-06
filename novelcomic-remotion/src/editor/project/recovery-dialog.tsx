'use client';

import React, {useState} from 'react';
import {useProjectContext} from './project-context';

export const RecoveryDialog: React.FC = () => {
	const {activeProject, draft, restoreDraft, discardDraft, downloadDraft} = useProjectContext();
	const [busy, setBusy] = useState(false);
	if (!activeProject || !draft) return null;

	const run = async (action: () => Promise<unknown>) => {
		setBusy(true);
		try { await action(); } finally { setBusy(false); }
	};

	return (
		<div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-6" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
			<div className="bg-editor-starter-panel text-editor-starter-text w-full max-w-lg rounded-2xl border border-amber-300/30 p-6 shadow-2xl">
				<h2 id="recovery-title" className="text-lg font-semibold">发现未提交的编辑</h2>
				<p className="text-editor-starter-text-muted mt-2 text-sm">工程“{activeProject.name}”有一份比当前正式版本更新的草稿。请选择恢复、丢弃或先下载备份。</p>
				<div className="mt-3 rounded-xl bg-black/20 p-3 text-xs"><div>草稿时间：{new Date(draft.updatedAt).toLocaleString()}</div><div className="mt-1 font-mono">hash {draft.contentHash.slice(0, 8)}</div></div>
				<div className="mt-5 flex flex-wrap justify-end gap-2">
					<button type="button" disabled={busy} className="rounded-lg border border-white/10 px-3 py-2 text-sm disabled:opacity-50" onClick={downloadDraft}>下载草稿</button>
					<button type="button" disabled={busy} className="rounded-lg border border-red-300/30 px-3 py-2 text-sm text-red-100 disabled:opacity-50" onClick={() => void run(discardDraft)}>丢弃草稿</button>
					<button type="button" disabled={busy} className="rounded-lg bg-editor-starter-accent px-3 py-2 text-sm disabled:opacity-50" onClick={() => void run(restoreDraft)}>恢复草稿</button>
				</div>
			</div>
		</div>
	);
};
