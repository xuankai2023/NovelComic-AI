import { AssetDownloadProgress } from './asset-download-progress';
import { AssetUploadProgress } from './asset-upload-progress';
import { CaptionProgress } from './caption-progress';
import { Task } from './get-tasks';
import { RenderProgress } from './render-progress';
import { TasksDoneAll } from './tasks-done-all';

export const TasksContent: React.FC<{
	tasks: Task[];
}> = ({ tasks }) => {
	return (
		<>
			<TasksDoneAll tasks={tasks} />
			{tasks.map((task) => {
				if (task.type === 'rendering') {
					return <RenderProgress key={task.id} renderTask={task} />;
				}

				if (task.type === 'captioning') {
					return <CaptionProgress key={task.id} captionTask={task} />;
				}

				if (task.type === 'uploading') {
					return <AssetUploadProgress key={task.id} assetUploadTask={task} />;
				}

				if (task.type === 'downloading') {
					return (
						<AssetDownloadProgress key={task.id} assetDownloadTask={task} />
					);
				}

				throw new Error(
					`Unknown task type: ${JSON.stringify(task satisfies never)}`,
				);
			})}
		</>
	);
};
