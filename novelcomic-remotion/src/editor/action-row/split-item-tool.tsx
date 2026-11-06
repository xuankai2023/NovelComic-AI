import {PlayerRef} from '@remotion/player';
import {useTranslations} from 'next-intl';
import React, {useCallback, useMemo} from 'react';
import {ScissorsIcon} from '../icons/scissors';
import {splitItem} from '../state/actions/split-item';
import {
	useAllItems,
	useSelectedItems,
	useWriteContext,
} from '../utils/use-context';
import {useTimelinePosition} from '../utils/use-timeline-position';

export function SplitItemTool({
	playerRef,
}: {
	playerRef: React.RefObject<PlayerRef | null>;
}) {
	const t = useTranslations('editor.actionRow.tools');
	const timelineWriteContext = useWriteContext();

	const {selectedItems} = useSelectedItems();
	const {items} = useAllItems();

	const currentFrame = useTimelinePosition({playerRef});

	const splittableRanges = useMemo(() => {
		if (selectedItems.length === 0) return [];

		const ranges = [];

		for (const itemId of selectedItems) {
			const item = items[itemId];
			if (!item) continue;

			if (item.durationInFrames <= 1) continue;

			ranges.push({
				itemId,
				start: item.from,
				end: item.from + item.durationInFrames,
			});
		}

		return ranges;
	}, [selectedItems, items]);

	const canSplit = useMemo(() => {
		return splittableRanges.some(
			(range) => currentFrame > range.start && currentFrame < range.end,
		);
	}, [currentFrame, splittableRanges]);

	const handleSplitClip = useCallback(() => {
		if (!canSplit) return;

		timelineWriteContext.setState({
			update: (state) => {
				let newState = state;
				for (const itemId of selectedItems) {
					const item = items[itemId];
					if (!item) continue;

					const itemStart = item.from;
					const itemEnd = itemStart + item.durationInFrames;

					if (currentFrame > itemStart && currentFrame < itemEnd) {
						newState = splitItem({
							state: newState,
							idToSplit: itemId,
							framePosition: currentFrame,
						});
					}
				}
				return newState;
			},
			commitToUndoStack: true,
		});
	}, [canSplit, timelineWriteContext, selectedItems, items, currentFrame]);

	return (
		<button
			onClick={handleSplitClip}
			disabled={!canSplit}
			className="editor-starter-focus-ring flex h-10 w-10 cursor-pointer items-center justify-center text-editor-starter-text transition-colors disabled:cursor-not-allowed disabled:opacity-50"
			title={t('splitAtPlayhead')}
			aria-label={t('splitAtPlayhead')}
		>
			<ScissorsIcon className="w-4" />
		</button>
	);
}
