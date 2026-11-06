import React from 'react';
import {formatBytes} from '../utils/format-bytes';

interface ProgressBarProps {
	progress: number;
	label?: string;
	showBytes?: {
		loaded: number;
		total: number;
	};
	compact?: boolean;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
	progress,
	label,
	showBytes,
	compact,
}) => {
	const normalizedProgress = Math.max(0, Math.min(1, progress));
	const percentage = Math.round(normalizedProgress * 100);

	if (compact) {
		return (
			<div className="flex w-full flex-1 flex-row items-center gap-2 text-xs text-editor-starter-text-muted">
				<div className="h-1 w-full flex-1 overflow-hidden rounded-full bg-editor-starter-surface-muted">
					<div
						className="h-full bg-editor-starter-accent transition-all duration-300"
						style={{width: `${percentage}%`}}
					/>
				</div>
				<div className="w-[35px] text-right">{percentage}%</div>
			</div>
		);
	}

	return (
		<div className="text-xs text-editor-starter-text-muted">
			{label && <div>{label}</div>}
			<div className="mt-2">
				{showBytes ? (
					<>
						{formatBytes(showBytes.loaded)} / {formatBytes(showBytes.total)} (
						{percentage}%)
					</>
				) : (
					<>{percentage}%</>
				)}
			</div>
			<div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-editor-starter-surface-muted">
				<div
					className="h-full bg-editor-starter-accent transition-all duration-300"
					style={{width: `${percentage}%`}}
				/>
			</div>
		</div>
	);
};
