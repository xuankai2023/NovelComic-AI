import type {DocumentCommand} from '../editor/commands/document-command-types';
import {compositorStore, type CompositorTask} from './compositor-store';

/**
 * AI and media providers finish outside the request. Their only document write
 * path is a command batch against the revision that created the task.
 */
export const startCompositorTask = (task: CompositorTask, commands: DocumentCommand[] = [], result?: unknown) => {
	setTimeout(() => { void (async () => {
		if (compositorStore.getTask(task.projectId, task.taskId).status === 'canceled') return;
		const running = compositorStore.updateTask(task.projectId, task.taskId, {status: 'running', progress: 0.1});
		if (running.status === 'canceled') return;
		try {
			let committed: unknown;
			if (commands.length) committed = await compositorStore.commit(task.projectId, task.baseRevision, task.requestId, commands);
			compositorStore.updateTask(task.projectId, task.taskId, {status: 'succeeded', progress: 1, result: result ?? committed});
		} catch (error) {
			compositorStore.updateTask(task.projectId, task.taskId, {status: 'failed', progress: 0, error: {code: 'TASK_FAILED', message: error instanceof Error ? error.message : 'Task failed', retryable: true}});
		}
	})(); }, 0);
};
