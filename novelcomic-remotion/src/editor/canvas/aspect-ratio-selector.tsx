import {Dropdown} from '@heroui/react';
import {useTranslations} from 'next-intl';
import React, {useCallback, useMemo, useRef} from 'react';
import {
	DEFAULT_COMPOSITION_HEIGHT,
	DEFAULT_COMPOSITION_WIDTH,
} from '../constants';
import {FEATURE_ASPECT_RATIO_SELECTOR} from '../flags';
import {EditorStarterItem} from '../items/item-type';
import {useDimensions, useWriteContext} from '../utils/use-context';

type AspectRatioPreset = {
	label: string;
	value: string;
	width: number;
	height: number;
};

const fitRatioToDefaultCanvas = (widthRatio: number, heightRatio: number) => {
	const scale = Math.floor(
		Math.min(
			DEFAULT_COMPOSITION_WIDTH / widthRatio,
			DEFAULT_COMPOSITION_HEIGHT / heightRatio,
		),
	);

	return {
		width: widthRatio * scale,
		height: heightRatio * scale,
	};
};

const ASPECT_RATIO_PRESETS: AspectRatioPreset[] = [
	{
		label: '16:9',
		value: '16:9',
		...fitRatioToDefaultCanvas(16, 9),
	},
	{label: '4:3', value: '4:3', ...fitRatioToDefaultCanvas(4, 3)},
	{label: '2:1', value: '2:1', ...fitRatioToDefaultCanvas(2, 1)},
	{label: '9:16', value: '9:16', ...fitRatioToDefaultCanvas(9, 16)},
	{label: '1:1', value: '1:1', ...fitRatioToDefaultCanvas(1, 1)},
	{label: '3:4', value: '3:4', ...fitRatioToDefaultCanvas(3, 4)},
];

function gcd(a: number, b: number): number {
	return b === 0 ? a : gcd(b, a % b);
}

function matchPreset(w: number, h: number): string {
	const d = gcd(w, h);
	const rw = w / d;
	const rh = h / d;
	const ratio = `${rw}:${rh}`;
	const match = ASPECT_RATIO_PRESETS.find((p) => p.value === ratio);
	return match ? match.value : 'custom';
}

const shouldCenterOnAspectRatioChange = (item: EditorStarterItem) => {
	return item.type === 'image' || item.type === 'video' || item.type === 'gif';
};

const centerItemInComposition = (
	item: EditorStarterItem,
	compositionWidth: number,
	compositionHeight: number,
): EditorStarterItem => {
	if (!shouldCenterOnAspectRatioChange(item)) {
		return item;
	}

	return {
		...item,
		left: Math.round((compositionWidth - item.width) / 2),
		top: Math.round((compositionHeight - item.height) / 2),
	};
};

const RatioIcon: React.FC<{width: number; height: number}> = ({
	width,
	height,
}) => {
	const maxDim = 16;
	const aspect = width / height;
	const w = aspect >= 1 ? maxDim : Math.round(maxDim * aspect);
	const h = aspect >= 1 ? Math.round(maxDim / aspect) : maxDim;

	return (
		<div className="flex h-4 w-4 items-center justify-center">
			<div
				className="rounded-[2px] border border-current"
				style={{width: w, height: h}}
			/>
		</div>
	);
};

const AspectRatioItem: React.FC<{
	option: AspectRatioPreset;
}> = ({option}) => {
	return (
		<Dropdown.Item
			key={option.value}
			id={option.value}
			textValue={`${option.label} ${option.width} x ${option.height}`}
			className="!w-full !rounded-[18px] !bg-transparent !px-0 !py-0 !shadow-none outline-none data-[hovered=true]:!bg-transparent data-[selected=true]:!bg-transparent"
		>
			{({isFocused, isHovered, isSelected}) => {
				const isActive = isFocused || isHovered || isSelected;

				return (
					<div
						className={`flex w-full items-center gap-3 rounded-[16px] px-3 py-3 transition-colors ${
							isActive
								? 'bg-editor-starter-surface-hover text-editor-starter-text'
								: 'text-editor-starter-text-muted'
						}`}
					>
						<div className="border-editor-starter-surface-separator bg-editor-starter-panel/70 text-editor-starter-text flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border">
							<RatioIcon width={option.width} height={option.height} />
						</div>
						<div className="min-w-0 flex-1">
							<div className="text-sm leading-none font-semibold">
								{option.label}
							</div>
							<div className="text-editor-starter-text-faint mt-1 text-xs">
								{option.width} x {option.height}
							</div>
						</div>
					</div>
				);
			}}
		</Dropdown.Item>
	);
};

export const AspectRatioSelector: React.FC = () => {
	const t = useTranslations('editor.canvas.aspectRatio');
	const {compositionWidth, compositionHeight} = useDimensions();
	const {setState} = useWriteContext();
	const containerRef = useRef<HTMLDivElement>(null);

	const currentPreset = useMemo(
		() => matchPreset(compositionWidth, compositionHeight),
		[compositionWidth, compositionHeight],
	);
	const selectValue = currentPreset === 'custom' ? null : currentPreset;

	const onValueChange = useCallback(
		(value: string) => {
			const preset = ASPECT_RATIO_PRESETS.find((p) => p.value === value);
			if (!preset) return;

			setState({
				update: (state) => ({
					...state,
					undoableState: {
						...state.undoableState,
						compositionWidth: preset.width,
						compositionHeight: preset.height,
						items: Object.fromEntries(
							Object.entries(state.undoableState.items).map(
								([itemId, item]) => [
									itemId,
									centerItemInComposition(item, preset.width, preset.height),
								],
							),
						),
					},
				}),
				commitToUndoStack: true,
			});
		},
		[setState],
	);

	if (!FEATURE_ASPECT_RATIO_SELECTOR) {
		return null;
	}

	const displayLabel =
		currentPreset === 'custom'
			? `${compositionWidth}x${compositionHeight}`
			: currentPreset;

	return (
		<div className="absolute top-2 left-2 z-10" ref={containerRef}>
			<Dropdown>
				<Dropdown.Trigger
					aria-label={t('triggerAriaLabel')}
					className="border-editor-starter-surface-separator bg-editor-starter-panel/80 text-editor-starter-text hover:bg-editor-starter-surface-hover/30 focus-visible:border-editor-starter-surface-subtle data-[focus-visible=true]:border-editor-starter-surface-subtle flex !h-[56px] !w-[56px] flex-col items-center justify-center gap-1.5 rounded-[16px] border !p-0 backdrop-blur-sm transition-colors outline-none focus-visible:ring-0 focus-visible:outline-none data-[focus-visible=true]:ring-0 data-[focus-visible=true]:outline-none"
				>
					<div className="flex h-5 w-5 shrink-0 items-center justify-center">
						<RatioIcon width={compositionWidth} height={compositionHeight} />
					</div>
					<span className="block h-[10px] max-w-[40px] truncate text-center text-[10px] leading-[10px] font-semibold">
						{displayLabel}
					</span>
				</Dropdown.Trigger>
				<Dropdown.Popover
					placement="top start"
					offset={8}
					containerPadding={0}
					UNSTABLE_portalContainer={containerRef.current ?? undefined}
					className="border-editor-starter-surface-separator bg-editor-starter-panel z-20 rounded-[20px] border p-2 shadow-[0_22px_70px_var(--color-editor-starter-popover-shadow)] [&_[data-slot=dropdown-menu]]:p-0 [&_[data-slot=menu-item]]:px-0"
				>
					<Dropdown.Menu
						aria-label={t('menuAriaLabel')}
						selectionMode="single"
						selectedKeys={selectValue ? [selectValue] : []}
						onAction={(key) => onValueChange(String(key))}
						className="w-[240px] rounded-[18px] bg-transparent p-0 outline-none"
					>
						{ASPECT_RATIO_PRESETS.map((preset) => (
							<AspectRatioItem key={preset.value} option={preset} />
						))}
					</Dropdown.Menu>
				</Dropdown.Popover>
			</Dropdown>
		</div>
	);
};
