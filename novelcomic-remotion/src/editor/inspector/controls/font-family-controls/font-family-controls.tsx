import * as Popover from '@radix-ui/react-popover';
import {useVirtualizer} from '@tanstack/react-virtual';
import {ChevronDown} from 'lucide-react';
import {useTranslations} from 'next-intl';
import React, {
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {flushSync} from 'react-dom';
import {scrollbarStyle} from '../../../constants';
import {GOOGLE_FONTS_LIST} from '../../../data/google-fonts-list';
import {
	FEATURE_FONT_FAMILY_CONTROLS_PREVIEW_ON_HOVER,
	FEATURE_FONT_FAMILY_DROPDOWN_RENDER_IN_FONT,
} from '../../../flags';
import {changeItem} from '../../../state/actions/change-item';
import {editAndRelayoutText} from '../../../state/actions/edit-and-relayout-text';
import {setTextItemHoverPreview} from '../../../state/actions/set-hover-preview';
import {loadFontFromTextItem} from '../../../utils/text/load-font-from-text-item';
import {makeFontPreviewName} from '../../../utils/text/load-font-preview';
import {useFontPreviewLoader} from '../../../utils/text/use-font-preview-loader';
import {useWriteContext} from '../../../utils/use-context';
import {InspectorSubLabel} from '../../components/inspector-label';
import {FontFamilySelectionItem} from './font-family-selection-item';

const FONT_ITEM_HEIGHT = 30;

const FontFamilyControlUnmemoized: React.FC<{
	fontFamily: string;
	itemId: string;
}> = ({fontFamily, itemId}) => {
	const t = useTranslations('editor.inspector.controls');
	const [search, setSearch] = useState('');
	const [isOpen, setIsOpen] = useState(false);
	const [highlightedIndex, setHighlightedIndex] = useState(-1);
	const {loadFontForPreview, loadedFonts} = useFontPreviewLoader();
	const {setState} = useWriteContext();

	const filteredFonts = useMemo(() => {
		if (!search) return GOOGLE_FONTS_LIST;
		return GOOGLE_FONTS_LIST.filter((font) =>
			font.fontFamily.toLowerCase().includes(search.toLowerCase()),
		);
	}, [search]);

	useEffect(() => {
		setHighlightedIndex(-1);
	}, [search]);

	const listRef = useRef<HTMLDivElement>(null);

	const virtualizer = useVirtualizer({
		count: filteredFonts.length,
		getScrollElement: () => listRef.current,
		estimateSize: () => FONT_ITEM_HEIGHT,
		overscan: 30,
	});

	const virtualItems = virtualizer.getVirtualItems();

	const selectedFontIndex = useMemo(() => {
		return filteredFonts.findIndex((font) => font.importName === fontFamily);
	}, [filteredFonts, fontFamily]);

	useEffect(() => {
		if (!isOpen) return;

		const loadVisibleFonts = async () => {
			const fontsToLoad = virtualItems.map(
				(item) => filteredFonts[item.index]?.fontFamily,
			);

			await Promise.all(
				fontsToLoad.map((fontFamilyToLoad) =>
					loadFontForPreview(fontFamilyToLoad),
				),
			);
		};

		loadVisibleFonts();
	}, [isOpen, virtualItems, filteredFonts, loadFontForPreview]);

	useEffect(() => {
		loadFontForPreview(fontFamily);
	}, [fontFamily, loadFontForPreview]);

	const fontPreviewStyle = useMemo(() => {
		return {
			fontFamily: FEATURE_FONT_FAMILY_DROPDOWN_RENDER_IN_FONT
				? makeFontPreviewName(fontFamily)
				: 'inherit',
		};
	}, [fontFamily]);

	const applyFontFamily = useCallback(
		(newFontFamily: string) => {
			setState({
				update: (state) => {
					const newState = changeItem(state, itemId, (i) => {
						if (i.type === 'text') {
							return editAndRelayoutText(i, () => {
								if (
									i.fontFamily === newFontFamily &&
									i.fontStyle.variant === 'normal' &&
									i.fontStyle.weight === '400'
								) {
									return i;
								}

								return {
									...i,
									fontFamily: newFontFamily,
									fontStyle: {
										variant: 'normal',
										weight: '400',
									},
								};
							});
						}
						if (i.type === 'captions') {
							if (
								i.fontFamily === newFontFamily &&
								i.fontStyle.variant === 'normal' &&
								i.fontStyle.weight === '400'
							) {
								return i;
							}

							return {
								...i,
								fontFamily: newFontFamily,
								fontStyle: {
									variant: 'normal',
									weight: '400',
								},
							};
						}
						throw new Error(
							'Item type does not implement font change: ' + JSON.stringify(i),
						);
					});

					return setTextItemHoverPreview({
						state: newState,
						hoverPreview: null,
					});
				},
				commitToUndoStack: true,
			});
		},
		[itemId, setState],
	);

	const onFontChange = useCallback(
		async (family: string) => {
			await loadFontFromTextItem({
				fontFamily: family,
				fontVariant: 'normal',
				fontWeight: '400',
				fontInfosDuringRendering: null,
			});
			applyFontFamily(family);
		},
		[applyFontFamily],
	);

	const closePopover = useCallback(() => {
		setIsOpen(false);
	}, [setIsOpen]);

	const handleFontSelect = useCallback(
		(newFontFamily: string) => {
			onFontChange(newFontFamily);
			closePopover();
		},
		[onFontChange, closePopover],
	);

	const handleOpenChange = useCallback(
		(newOpen: boolean) => {
			// here we wait first until popover is open before measuring the virtualizer
			flushSync(() => setIsOpen(newOpen));

			// Scroll to selected font when opening
			if (newOpen) {
				// measure the virtualizer in sync mode to ensure the virtualizer is ready before scrolling
				flushSync(() => {
					virtualizer.measure();
				});

				if (selectedFontIndex !== -1) {
					virtualizer.scrollToIndex(selectedFontIndex, {
						align: 'center',
						behavior: 'auto',
					});
					// Set the highlighted index to the selected font
					setHighlightedIndex(selectedFontIndex);
				} else {
					// If no font is selected, highlight the first font
					setHighlightedIndex(0);
				}
			} else {
				setState({
					update: (state) => {
						return setTextItemHoverPreview({
							state,
							hoverPreview: null,
						});
					},
					commitToUndoStack: false,
				});

				// Reset highlighted index when closing
				setHighlightedIndex(-1);
			}
		},
		[selectedFontIndex, virtualizer, setState],
	);

	const previewedFont = useRef<string | null>(null);

	const previewFont = useCallback(
		async (fontFamilyToPreview: string) => {
			if (!FEATURE_FONT_FAMILY_CONTROLS_PREVIEW_ON_HOVER) {
				return;
			}

			previewedFont.current = fontFamilyToPreview;
			await loadFontFromTextItem({
				fontFamily: fontFamilyToPreview,
				fontVariant: 'normal',
				fontWeight: '400',
				fontInfosDuringRendering: null,
			});

			if (previewedFont.current === fontFamilyToPreview) {
				setState({
					update: (state) => {
						return {
							...state,
							textItemHoverPreview: {
								itemId,
								fontFamily: fontFamilyToPreview,
								type: 'font-family',
							},
						};
					},
					commitToUndoStack: false,
				});
			}
		},
		[itemId, setState],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (!isOpen) return;

			switch (e.key) {
				case 'ArrowDown':
					e.preventDefault();
					setHighlightedIndex((prev) => {
						const newIndex =
							prev === -1 ? 0 : Math.min(prev + 1, filteredFonts.length - 1);
						previewFont(filteredFonts[newIndex].fontFamily);
						virtualizer.scrollToIndex(newIndex, {
							align: 'center',
							behavior: 'auto',
						});
						return newIndex;
					});
					break;
				case 'ArrowUp':
					e.preventDefault();
					setHighlightedIndex((prev) => {
						const newIndex =
							prev === -1 ? filteredFonts.length - 1 : Math.max(prev - 1, 0);
						previewFont(filteredFonts[newIndex].fontFamily);
						virtualizer.scrollToIndex(newIndex, {
							align: 'center',
							behavior: 'auto',
						});
						return newIndex;
					});
					break;
				case 'Enter':
					e.preventDefault();
					if (
						highlightedIndex >= 0 &&
						highlightedIndex < filteredFonts.length
					) {
						const selectedFont = filteredFonts[highlightedIndex];
						if (selectedFont) {
							handleFontSelect(selectedFont.fontFamily);
						}
					}
					break;
				case 'Escape':
					e.preventDefault();
					closePopover();
					break;
			}
		},
		[
			isOpen,
			filteredFonts,
			highlightedIndex,
			virtualizer,
			handleFontSelect,
			closePopover,
			previewFont,
		],
	);

	const onPointerDownOutside = useCallback(
		(e: CustomEvent<{originalEvent: PointerEvent}>) => {
			closePopover();
			e.stopPropagation();
		},
		[closePopover],
	);

	const resetFontFamily = useCallback(() => {
		setState({
			update: (state) => {
				return setTextItemHoverPreview({
					state,
					hoverPreview: null,
				});
			},
			commitToUndoStack: false,
		});
	}, [setState]);

	return (
		<div>
			<InspectorSubLabel>{t('font')}</InspectorSubLabel>
			<Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
				<Popover.Trigger asChild>
					<button
						type="button"
						className="border-editor-starter-surface-separator bg-editor-starter-surface-hover text-editor-starter-text-muted hover:bg-editor-starter-surface-active focus-visible:ring-editor-starter-accent flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors focus-visible:ring-1 focus-visible:outline-none"
						style={fontPreviewStyle}
						aria-label={t('fontFamily')}
					>
						<span className="truncate">{fontFamily}</span>
						<ChevronDown className="text-editor-starter-text-faint size-3 shrink-0" />
					</button>
				</Popover.Trigger>
				<Popover.Portal>
					<>
						<div className="absolute inset-0"></div>
						<Popover.Content
							onPointerDownOutside={onPointerDownOutside}
							side="left"
							sideOffset={5}
							align="start"
							collisionBoundary={null}
							className="bg-editor-starter-panel z-50 w-64 overflow-hidden shadow-xl"
							style={{
								maxHeight: '300px',
							}}
							onKeyDown={handleKeyDown}
						>
							<div className="border-editor-starter-border border-b">
								<input
									type="text"
									placeholder={t('searchFonts')}
									value={search}
									aria-label={t('searchFonts')}
									onChange={(e) => setSearch(e.target.value)}
									className="editor-starter-field text-editor-starter-text-muted w-full appearance-none border-none px-3 py-2 text-xs"
									autoFocus
								/>
							</div>
							<div
								ref={listRef}
								className="overflow-y-scroll"
								style={{
									maxHeight: '240px',
									minHeight: filteredFonts.length > 0 ? '100px' : '0',
									...scrollbarStyle,
								}}
							>
								<div
									style={{
										height: `${virtualizer.getTotalSize() + 8}px`,
										width: '100%',
										position: 'relative',
										paddingTop: 4,
										paddingBottom: 4,
									}}
								>
									{virtualItems.map((virtualItem) => {
										const font = filteredFonts[virtualItem.index];

										if (!font) {
											throw new Error(
												'Font not found for virtual item: ' + virtualItem.index,
											);
										}

										const isSelected = fontFamily === font.fontFamily;
										const isHighlighted =
											highlightedIndex === virtualItem.index;
										const isLoaded = FEATURE_FONT_FAMILY_DROPDOWN_RENDER_IN_FONT
											? loadedFonts.has(font.fontFamily)
											: true;

										return (
											<FontFamilySelectionItem
												fontFamily={font.fontFamily}
												isLoaded={isLoaded}
												start={virtualItem.start}
												size={virtualItem.size}
												isHighlighted={isHighlighted}
												isSelected={isSelected}
												applyFontFamily={applyFontFamily}
												setIsOpen={setIsOpen}
												previewedFont={previewedFont}
												key={virtualItem.key}
												resetFontFamily={resetFontFamily}
												previewFont={previewFont}
											/>
										);
									})}
								</div>
							</div>
							{filteredFonts.length === 0 && (
								<div className="px-3 py-2 text-sm text-gray-400">
									No fonts found
								</div>
							)}
						</Popover.Content>
					</>
				</Popover.Portal>
			</Popover.Root>
		</div>
	);
};

export const FontFamilyControl = memo(FontFamilyControlUnmemoized);
