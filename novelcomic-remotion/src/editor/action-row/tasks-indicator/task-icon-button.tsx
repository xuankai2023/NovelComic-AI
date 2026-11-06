import {Popover} from '@heroui/react';
import {ListTodo} from 'lucide-react';
import {useTranslations} from 'next-intl';
import React, {useEffect, useImperativeHandle, useMemo, useState} from 'react';
import {getDownloadTasks} from '../../caching/download-tasks';
import {
	useDownloadProgresses,
	useLocalUrls,
} from '../../caching/load-to-blob-url';
import {scrollbarStyle} from '../../constants';
import {FEATURE_WARN_ON_LONG_RUNNING_PROCESS_IN_PROGRESS} from '../../flags';
import {clsx} from '../../utils/clsx';
import {
	useAssets,
	useAssetStatus,
	useCaptionState,
	useRendering,
} from '../../utils/use-context';
import {RenderJobPanel} from '../../rendering/render-job-panel';
import {assetContextToAssetTasks} from './asset-uploads-to-task';
import {getTasks} from './get-tasks';
import {getTasksLabel} from './get-tasks-label';
import {TasksContent} from './tasks-content';
import {taskIndicatorRef} from './tasks-indicator';

export const TaskIconButton: React.FC = () => {
	const t = useTranslations('editor.tasks');
	const [isOpen, setIsOpen] = useState(false);
	const renderState = useRendering();
	const captionState = useCaptionState();
	const {assetStatus} = useAssetStatus();
	const {assets} = useAssets();
	const downloadProgresses = useDownloadProgresses();
	const localUrls = useLocalUrls();

	const tasks = useMemo(() => {
		return getTasks({
			renderState,
			captioning: captionState,
			assetUploads: assetContextToAssetTasks({assetStatus, assets}),
			downloadProgresses: getDownloadTasks({
				downloadProgresses,
				assets,
				localUrls,
			}),
		});
	}, [
		renderState,
		captionState,
		assetStatus,
		assets,
		downloadProgresses,
		localUrls,
	]);
	const persistedRenderJobs = useMemo(
		() =>
			renderState
				.map((task) => task.renderJob)
				.filter((job): job is NonNullable<typeof job> => Boolean(job)),
		[renderState],
	);
	const legacyTasks = useMemo(
		() => tasks.filter((task) => task.type !== 'rendering' || !task.renderJob),
		[tasks],
	);

	const {progress: progressLabel} =
		tasks.length > 0
			? getTasksLabel(tasks, t)
			: {progress: {type: 'success' as const}};

	const hasActiveTasks = tasks.some((task) => {
		if (task.type === 'rendering') {
			return (
				task.status.type === 'in-progress' ||
				task.status.type === 'render-initiated' ||
				task.status.type === 'cancel-requested'
			);
		}
		if (task.type === 'captioning') {
			return task.status.type !== 'done';
		}
		if (task.type === 'uploading' || task.type === 'downloading') {
			return true;
		}
		return false;
	});

	useImperativeHandle(taskIndicatorRef, () => {
		return {
			open: () => setIsOpen(true),
			close: () => setIsOpen(false),
		};
	}, []);

	useEffect(() => {
		if (!FEATURE_WARN_ON_LONG_RUNNING_PROCESS_IN_PROGRESS) {
			return;
		}

		if (
			progressLabel.type !== 'numeric-progress' &&
			progressLabel.type !== 'working'
		) {
			return;
		}

		window.onbeforeunload = () => {
			return t('leaveWarning');
		};

		return () => {
			window.onbeforeunload = null;
		};
	}, [progressLabel.type, t]);

	return (
		<Popover isOpen={isOpen} onOpenChange={setIsOpen}>
			<Popover.Trigger>
				<button
					type="button"
					aria-label={t('ariaLabel')}
					className={clsx(
						'text-editor-starter-text-muted hover:bg-editor-starter-surface-hover relative flex size-9 items-center justify-center rounded-lg transition-colors',
						isOpen &&
							'bg-editor-starter-surface-active text-editor-starter-text',
					)}
				>
					<ListTodo className="size-[18px]" strokeWidth={2} />
					{hasActiveTasks ? (
						<span className="bg-editor-starter-accent absolute top-1.5 right-1.5 size-2 animate-pulse rounded-full" />
					) : null}
					{!hasActiveTasks && tasks.length > 0 ? (
						<span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-green-500" />
					) : null}
				</button>
			</Popover.Trigger>
			<Popover.Content
				placement="bottom start"
				offset={10}
				shouldFlip={false}
				className="border-editor-starter-surface-separator bg-editor-starter-panel text-editor-starter-text w-[300px] rounded-[10px] border p-0 shadow-[0_22px_70px_var(--color-editor-starter-popover-shadow)]"
			>
				<Popover.Dialog className="p-2 outline-none">
					<div
						style={scrollbarStyle}
						className="divide-editor-starter-border text-editor-starter-text-muted max-h-[400px] divide-y overflow-auto text-sm"
					>
						{tasks.length > 0 ? (
							<>
								<RenderJobPanel jobs={persistedRenderJobs} />
								<TasksContent tasks={legacyTasks} />
							</>
						) : (
							<div className="text-editor-starter-text-faint flex items-center justify-center py-8 text-xs">
								{t('empty')}
							</div>
						)}
					</div>
				</Popover.Dialog>
			</Popover.Content>
		</Popover>
	);
};
