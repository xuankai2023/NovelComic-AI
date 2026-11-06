import {useMemo} from 'react';

export function TimelineItemHeader({filename}: {filename: string}) {
	const style = useMemo(() => {
		// Prevent clipping of the text shadow
		return {
			padding: 10,
			marginLeft: 0,
			marginRight: 0,
			marginTop: -10,
			marginBottom: -10,
			textShadow: '0 0 10px black, 0 0 10px black, 1px 1px 1px black',
		};
	}, []);

	return (
		<div
			className="pointer-events-none absolute top-0 flex h-20 w-full items-start justify-between"
			title={filename}
		>
			<span
				className="truncate px-[10px] text-xs font-medium text-white/90"
				style={style}
			>
				{filename}
			</span>
		</div>
	);
}
