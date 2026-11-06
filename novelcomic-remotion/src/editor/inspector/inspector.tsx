import React, { useEffect, useState } from 'react';
import { useAllItems, useSelectedItems } from '../utils/use-context';
import { InspectorDock } from './inspector-dock';

export const INSPECTOR_WIDTH = 350;
const INSPECTOR_EXIT_MS = 220;

export const Inspector: React.FC = () => {
	const { selectedItems } = useSelectedItems();
	const { items } = useAllItems();
	const selectedItemId = selectedItems.length === 1 ? selectedItems[0] : null;
	const [renderedItemId, setRenderedItemId] = useState<string | null>(selectedItemId);
	// const [isVisible, setIsVisible] = useState(Boolean(selectedItemId));

	useEffect(() => {
		if (selectedItemId) {
			setRenderedItemId(selectedItemId);
			// setIsVisible(true);
			return;
		}

		// setIsVisible(false);

		const timeout = window.setTimeout(() => {
			setRenderedItemId(null);
		}, INSPECTOR_EXIT_MS);

		return () => {
			window.clearTimeout(timeout);
		};
	}, [selectedItemId]);

	useEffect(() => {
		if (renderedItemId && !items[renderedItemId]) {
			setRenderedItemId(null);
			// setIsVisible(false);
		}
	}, [items, renderedItemId]);

	if (!renderedItemId) {
		return null;
	}

	return (
		<InspectorDock
			itemId={renderedItemId}
		// isVisible={!!isVisible}
		// transitionMs={INSPECTOR_EXIT_MS}
		/>
	);
};
