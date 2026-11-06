import React from 'react';

export const DownloadInProgress: React.FC<{
	overallProgress: number;
}> = ({overallProgress}) => {
	return (
		<div className="flex flex-1 flex-row items-center gap-2">
			<div className="h-1 w-full flex-1 overflow-hidden rounded-sm bg-editor-starter-surface-muted">
				<div
					style={{
						width: `${overallProgress * 100}%`,
					}}
					className="bg-editor-starter-accent h-full"
				></div>
			</div>
			<div className="w-[35px] text-right text-xs">
				{Math.floor(overallProgress * 100)}%
			</div>
		</div>
	);
};
