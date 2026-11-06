import type {EditorStarterItem} from '../../items/item-type';
import type {TransformTimelineProperty} from '../../motion/transform-property-timeline';
import {TRACK_DIVIDER_HEIGHT} from '../../state/items';
import type {TimelineTrackAndLayout} from '../utils/drag/calculate-track-heights';
import {
	TRANSFORM_GROUP_ROW_HEIGHT,
	TRANSFORM_PROPERTY_ROW_HEIGHT,
} from './constants';

export const applyTransformPropertyTimelineLayout = ({
	tracks,
	items,
	expandedItemId,
	visibleProperties,
}: {
	tracks: TimelineTrackAndLayout[];
	items: Record<string, EditorStarterItem>;
	expandedItemId: string | null;
	visibleProperties: readonly TransformTimelineProperty[];
}): TimelineTrackAndLayout[] => {
	let top = 0;
	return tracks.map((entry) => {
		const expanded = Boolean(
			expandedItemId &&
			entry.track.items.includes(expandedItemId) &&
			items[expandedItemId]?.type === 'image',
		);
		const propertyRowsHeight = expanded
			? TRANSFORM_GROUP_ROW_HEIGHT +
				visibleProperties.length * TRANSFORM_PROPERTY_ROW_HEIGHT
			: 0;
		const next = {
			...entry,
			top,
			baseHeight: entry.baseHeight,
			propertyRowsHeight,
			height: entry.baseHeight + propertyRowsHeight,
		};
		top += next.height + TRACK_DIVIDER_HEIGHT;
		return next;
	});
};
