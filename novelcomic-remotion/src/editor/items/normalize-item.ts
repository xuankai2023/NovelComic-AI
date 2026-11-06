import {
	CaptionsItem,
	normalizeCaptionStyle,
} from './captions/captions-item-type';
import {EditorStarterItem} from './item-type';

export const normalizeEditorStarterItem = (
	item: EditorStarterItem,
): EditorStarterItem => {
	if (item.type !== 'captions') {
		return item;
	}

	const captionsItem = item as CaptionsItem & {
		captionStyle?: unknown;
	};
	const captionStyle = normalizeCaptionStyle(captionsItem.captionStyle);

	if (captionsItem.captionStyle === captionStyle) {
		return item;
	}

	return {
		...captionsItem,
		captionStyle,
	};
};

export const normalizeEditorStarterItemsRecord = (
	items: Record<string, EditorStarterItem>,
): Record<string, EditorStarterItem> => {
	let changed = false;
	const normalizedEntries = Object.entries(items).map(([id, item]) => {
		const normalizedItem = normalizeEditorStarterItem(item);
		if (normalizedItem !== item) {
			changed = true;
		}

		return [id, normalizedItem] as const;
	});

	return changed ? Object.fromEntries(normalizedEntries) : items;
};

export const normalizeEditorStarterItemArray = (
	items: EditorStarterItem[],
): EditorStarterItem[] => {
	let changed = false;

	const normalizedItems = items.map((item) => {
		const normalizedItem = normalizeEditorStarterItem(item);
		if (normalizedItem !== item) {
			changed = true;
		}

		return normalizedItem;
	});

	return changed ? normalizedItems : items;
};
