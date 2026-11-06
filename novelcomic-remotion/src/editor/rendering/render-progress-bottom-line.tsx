import {ProgressBar} from '../captioning/progress-bar';
import {formatBytes} from '../utils/format-bytes';
import {formatRelativeTime} from './format-relative-time';
import {RenderingTask} from './render-state';
import {useCurrentTime} from './use-current-time';

export const RenderProgressBottomLine: React.FC<{
	renderTask: RenderingTask;
}> = ({renderTask}) => {
	const time = useCurrentTime();
	if (renderTask.status.type === 'done') {
		const line = [
			formatBytes(renderTask.status.outputSizeInBytes),
			formatRelativeTime({
				timestamp: renderTask.status.doneAt,
				now: time,
			}),
		]
			.filter(Boolean)
			.join(' • ');

		return <div className="text-xs opacity-50">{line}</div>;
	}

	if (renderTask.status.type === 'in-progress') {
		return (
			<ProgressBar progress={renderTask.status.overallProgress} compact />
		);
	}

	if (renderTask.status.type === 'render-initiated') {
		return <ProgressBar progress={0} compact />;
	}

	if (renderTask.status.type === 'cancel-requested') {
		return <ProgressBar progress={renderTask.status.overallProgress} compact />;
	}

	if (renderTask.status.type === 'canceled') {
		return <div className="text-xs opacity-50">Canceled</div>;
	}

	if (renderTask.status.type === 'error') {
		return (
			<div
				className="text-left text-xs break-all text-red-300"
				title={renderTask.status.error}
			>
				{renderTask.status.error}
			</div>
		);
	}

	throw new Error(
		'Unknown render task status: ' +
			JSON.stringify(renderTask.status satisfies never),
	);
};
