import {useCallback, useMemo} from 'react';
import {copyToClipboard} from '../../clipboard/copy-to-clipboard';
import {ContextMenuItem, ContextMenuSeparator} from '../../context-menu';
import {
	FEATURE_BRING_TO_FRONT,
	FEATURE_COPY_LAYERS,
	FEATURE_CUT_LAYERS,
	FEATURE_DUPLICATE_LAYERS,
	FEATURE_SEND_TO_BACK,
} from '../../flags';
import {EditorStarterItem} from '../../items/item-type';
import {bringToFrontOrBack} from '../../state/actions/bring-item-to-front-or-back';
import {cutItems} from '../../state/actions/cut-items';
import {duplicateItems} from '../../state/actions/duplicate-items';
import {
	useAllItems,
	useSelectedItems,
	useWriteContext,
} from '../../utils/use-context';

export const TimelineItemContextMenu: React.FC<{
	item: EditorStarterItem;
}> = ({item}) => {
	const {setState} = useWriteContext();
	const {selectedItems} = useSelectedItems();
	const {items: allItems} = useAllItems();

	// determine if we should operate on multiple items:
	// - multiple items are selected AND
	// - the right-clicked item is part of that selection
	const isMultiSelection = useMemo(
		() => selectedItems.length > 1 && selectedItems.includes(item.id),
		[selectedItems, item.id],
	);

	// for copy/cut/duplicate: operate on all selected items if conditions are met,
	// otherwise operate only on the right-clicked item
	const targetItems = useMemo(() => {
		return isMultiSelection ? selectedItems.map((id) => allItems[id]) : [item];
	}, [isMultiSelection, selectedItems, item, allItems]);

	// layer ordering operations always work on the individual
	// right-clicked item, not on the selection
	const handleBringToFront = useCallback(
		(e: Event) => {
			e.stopPropagation();
			setState({
				update: (state) =>
					bringToFrontOrBack({
						state,
						itemId: item.id, // Always the right-clicked item
						position: 'front',
					}),
				commitToUndoStack: true,
			});
		},
		[item.id, setState],
	);

	const handleSendToBack = useCallback(
		(e: Event) => {
			e.stopPropagation();
			setState({
				update: (state) =>
					bringToFrontOrBack({
						state,
						itemId: item.id, // Always the right-clicked item
						position: 'back',
					}),
				commitToUndoStack: true,
			});
		},
		[item.id, setState],
	);

	const handleCopy = useCallback(
		(e: Event) => {
			e.stopPropagation();
			copyToClipboard(targetItems);
		},
		[targetItems],
	);

	const handleCut = useCallback(
		(e: Event) => {
			e.stopPropagation();
			copyToClipboard(targetItems);
			setState({
				update: (state) =>
					cutItems(
						state,
						targetItems.map((targetItem) => targetItem.id),
					),
				commitToUndoStack: true,
			});
		},
		[targetItems, setState],
	);
	const handleDuplicate = useCallback(
		(e: Event) => {
			e.stopPropagation();
			setState({
				update: (state) =>
					duplicateItems(
						state,
						targetItems.map((targetItem) => targetItem.id),
					),
				commitToUndoStack: true,
			});
		},
		[targetItems, setState],
	);

	const handleContextMenuPointerDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			e.stopPropagation();
		},
		[],
	);

	return (
		<>
			{FEATURE_CUT_LAYERS ? (
				<ContextMenuItem
					className="flex items-center gap-3"
					onSelect={handleCut}
					onPointerDown={handleContextMenuPointerDown}
				>
					Cut
				</ContextMenuItem>
			) : null}
			{FEATURE_COPY_LAYERS && (
				<ContextMenuItem
					className="flex items-center gap-3"
					onSelect={handleCopy}
					onPointerDown={handleContextMenuPointerDown}
				>
					Copy
				</ContextMenuItem>
			)}
			{FEATURE_DUPLICATE_LAYERS && (
				<ContextMenuItem
					className="flex items-center gap-3"
					onSelect={handleDuplicate}
					onPointerDown={handleContextMenuPointerDown}
				>
					Duplicate
				</ContextMenuItem>
			)}
			<ContextMenuSeparator />
			{FEATURE_BRING_TO_FRONT ? (
				<ContextMenuItem
					className="flex items-center gap-3"
					onSelect={handleBringToFront}
					onPointerDown={handleContextMenuPointerDown}
				>
					Bring to front
				</ContextMenuItem>
			) : null}
			{FEATURE_SEND_TO_BACK ? (
				<ContextMenuItem
					className="flex items-center gap-3"
					onSelect={handleSendToBack}
					onPointerDown={handleContextMenuPointerDown}
				>
					Send to back
				</ContextMenuItem>
			) : null}
		</>
	);
};
