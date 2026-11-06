import React, {useMemo, useRef} from 'react';
import {EditorStarterItem} from '../../items/item-type';
import {clsx} from '../../utils/clsx';
import {useItemDrag} from '../utils/drag/use-timeline-item-drag';

export const TIMELINE_ITEM_BORDER_WIDTH = 2;

export function TimelineItemContainer({
	children,
	isLocked,
	isSelected,
	item,
}: {
	children: React.ReactNode;
	isLocked: boolean;
	isSelected: boolean;
	item: EditorStarterItem;
}) {
	const timelineItemRef = useRef<HTMLDivElement>(null);

	const {onPointerDown, onClick} = useItemDrag({
		draggedItem: item,
	});
	const style = useMemo(() => {
		return {
			borderWidth: TIMELINE_ITEM_BORDER_WIDTH,
		};
	}, []);

	return (
		<div
			ref={timelineItemRef}
			onPointerDown={isLocked ? undefined : onPointerDown}
			onClick={onClick}
			className={clsx(
				'ae-timeline-item border-editor-starter-border bg-editor-starter-borde absolute box-border h-full w-full cursor-pointer overflow-hidden rounded-[10px] border select-none',
				isSelected && '!border-editor-starter-accent !border-3',
				isLocked && 'cursor-not-allowed opacity-80',
			)}
			style={style}
		>
			{children}
		</div>
	);
}
