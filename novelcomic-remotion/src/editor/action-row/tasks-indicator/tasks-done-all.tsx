import { useCallback, useMemo } from 'react';
import {useTranslations} from 'next-intl';
import { clearTasks, getCanClearTasks } from '../../state/actions/clear-tasks';
import { useWriteContext } from '../../utils/use-context';
import { Task } from './get-tasks';
export const TasksDoneAll: React.FC<{
	tasks: Task[];
}> = ({ tasks }) => {
	const t = useTranslations('editor.tasks');
	const { setState } = useWriteContext();
	const canClearTasks = useMemo(() => {
		return getCanClearTasks(tasks);
	}, [tasks]);
	const onClick = useCallback(() => {
		setState({
			commitToUndoStack: false,
			update: (prevState) => {
				return clearTasks(prevState);
			},
		});
	}, [setState]);

	return (
		<div className="flex flex-row items-center justify-end px-2 py-1">
			<button
				onClick={onClick}
				disabled={!canClearTasks}
				className="editor-starter-focus-ring flex flex-row items-center gap-2 rounded px-2 py-1 text-xs text-editor-starter-text-muted enabled:cursor-pointer enabled:hover:bg-editor-starter-surface-hover enabled:hover:text-editor-starter-text disabled:opacity-50 mb-1"
				aria-label={t('clearAll')}
			>
				{t('clearAll')}
			</button>
		</div>
	);
};
