'use client';

import {Check, Download, RotateCcw, Square} from 'lucide-react';
import React, {useCallback, useState} from 'react';
import {formatBytes} from '../utils/format-bytes';
import {cancelRenderJob, retryRenderJob} from './render-job-runtime';
import {renderJobStore} from './render-job-store';
import type {RenderJob} from './render-job-types';

const statusLabel: Record<RenderJob['status'], string> = {
	queued: '排队中',
	validating: '校验中',
	submitted: '已提交',
	running: '渲染中',
	'cancel-requested': '取消中',
	succeeded: '已完成',
	failed: '失败',
	canceled: '已取消',
};

const kindLabel: Record<RenderJob['kind'], string> = {
	'preview-frame': '单帧预览',
	'full-video': '全片',
	batch: '批次',
	merge: '合并',
	delivery: '交付',
};

const isActive = (status: RenderJob['status']) =>
	['queued', 'validating', 'submitted', 'running', 'cancel-requested'].includes(
		status,
	);

const shortHash = (hash: string) => hash.slice(0, 8);
const dateLabel = (value?: string) =>
	value ? new Date(value).toLocaleString() : '—';

export const RenderJobPanel: React.FC<{
	jobs: RenderJob[];
	compact?: boolean;
}> = ({jobs, compact = true}) => {
	const [busyJobId, setBusyJobId] = useState<string | null>(null);

	const cancel = useCallback(async (job: RenderJob) => {
		setBusyJobId(job.jobId);
		try {
			await cancelRenderJob(job);
		} finally {
			setBusyJobId(null);
		}
	}, []);

	const retry = useCallback(async (job: RenderJob) => {
		setBusyJobId(job.jobId);
		try {
			await retryRenderJob(job);
		} finally {
			setBusyJobId(null);
		}
	}, []);

	const dismiss = useCallback(async (job: RenderJob) => {
		if (isActive(job.status)) return;
		await renderJobStore.delete(job.jobId, job.projectId);
	}, []);

	if (jobs.length === 0) return null;

	return (
		<div className={compact ? 'divide-y divide-white/10' : 'space-y-2'}>
			{jobs.map((job) => {
				const busy = busyJobId === job.jobId;
				const canRetry =
					job.status === 'failed' &&
					job.lastError?.retryable === true &&
					job.attempt < job.maxAttempts;
				return (
					<div key={job.jobId} className="space-y-1.5 px-3 py-2 text-xs">
						<div className="flex items-center justify-between gap-2">
							<div className="min-w-0 truncate font-medium text-white/90">
								{kindLabel[job.kind]} · {job.projectName ?? job.projectId}
							</div>
							<span className="shrink-0 text-white/60">
								{statusLabel[job.status]}
							</span>
						</div>
						<div className="text-white/55">
							Revision {job.inputRevision ?? '—'} · hash{' '}
							{shortHash(job.inputContentHash)} · {job.backend}
						</div>
						<div className="flex items-center gap-2 text-white/55">
							<span>
								attempt {job.attempt}/{job.maxAttempts}
							</span>
							<span>{Math.round(job.progress * 100)}%</span>
							<span className="truncate">开始 {dateLabel(job.startedAt)}</span>
							{job.finishedAt ? (
								<span className="truncate">结束 {dateLabel(job.finishedAt)}</span>
							) : null}
						</div>
						{job.status === 'running' || job.status === 'cancel-requested' ? (
							<div className="h-1 overflow-hidden rounded bg-white/10">
								<div
									className="h-full rounded bg-sky-400 transition-[width]"
									style={{width: `${Math.round(job.progress * 100)}%`}}
								/>
							</div>
						) : null}
						{job.lastError ? (
							<div
								className="break-words text-red-300"
								title={job.lastError.code}
							>
								{job.lastError.message}
								{job.lastError.retryable ? '（可重试）' : ''}
							</div>
						) : null}
						{job.status === 'succeeded' ? (
							<div className="text-white/55">
								完成 {dateLabel(job.finishedAt)} ·{' '}
								{job.outputSizeInBytes !== undefined
									? formatBytes(job.outputSizeInBytes)
									: '—'}
								{job.checksum ? ` · sha256 ${shortHash(job.checksum)}` : ''}
							</div>
						) : null}
						<div className="flex items-center justify-end gap-1">
							{job.status === 'succeeded' && job.outputFile ? (
								<a
									href={job.outputFile}
									target="_blank"
									rel="noreferrer"
									download={job.outputName}
									className="rounded p-1 text-white/70 hover:bg-white/10 hover:text-white"
									title="查看或下载输出"
								>
									<Download className="size-3.5" />
								</a>
							) : null}
							{isActive(job.status) ? (
								<button
									type="button"
									disabled={busy}
									onClick={() => void cancel(job)}
									className="rounded p-1 text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-40"
									title="取消渲染"
								>
									<Square className="size-3.5" />
								</button>
							) : null}
							{canRetry ? (
								<button
									type="button"
									disabled={busy}
									onClick={() => void retry(job)}
									className="rounded p-1 text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-40"
									title="重试"
								>
									<RotateCcw className="size-3.5" />
								</button>
							) : null}
							{!isActive(job.status) ? (
								<button
									type="button"
									disabled={busy}
									onClick={() => void dismiss(job)}
									className="rounded p-1 text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-40"
									title="移除任务"
								>
									<Check className="size-3.5" />
								</button>
							) : null}
						</div>
					</div>
				);
			})}
		</div>
	);
};
