import type {Color} from '@heroui/react';
import {
	ColorArea,
	ColorField,
	ColorPicker,
	ColorSlider,
	ColorSwatch,
	Label,
	parseColor,
} from '@heroui/react';
import {useTranslations} from 'next-intl';
import {memo, useCallback, useEffect, useMemo, useRef} from 'react';
import {CaptionsItem} from '../items/captions/captions-item-type';
import {SolidItem} from '../items/solid/solid-item-type';
import {TextItem, TextItemBackground} from '../items/text/text-item-type';
import {changeItem} from '../state/actions/change-item';
import {useWriteContext} from '../utils/use-context';
import {InspectorSubLabel} from './components/inspector-label';

// parseColor only supports hex/rgb/hsl/hsb — convert any CSS color (incl. named) to hex first
const cssColorToHex = (cssColor: string): string => {
	try {
		parseColor(cssColor);
		return cssColor;
	} catch {
		try {
			const canvas = document.createElement('canvas');
			canvas.width = 1;
			canvas.height = 1;
			const ctx = canvas.getContext('2d');
			if (!ctx) return '#000000';
			ctx.fillStyle = cssColor;
			ctx.fillRect(0, 0, 1, 1);
			const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data);
			return (
				'#' +
				[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')
			);
		} catch {
			return '#000000';
		}
	}
};

const ColorInspectorUnmemoized: React.FC<{
	color: string;
	itemId: string;
	colorType: 'color' | 'highlightColor' | 'strokeColor' | 'backgroundColor';
	accessibilityLabel: string;
}> = ({color, itemId, colorType, accessibilityLabel}) => {
	const t = useTranslations('editor.inspector.controls');
	const {setState} = useWriteContext();
	const commitTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const pendingCommitRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		return () => {
			if (commitTimeoutRef.current) {
				clearTimeout(commitTimeoutRef.current);
			}
			if (pendingCommitRef.current) {
				pendingCommitRef.current();
			}
		};
	}, []);

	const onColorChange = useCallback(
		(newColorObj: Color) => {
			const newColor = newColorObj.toString('hex');

			setState({
				update: (state) => {
					return changeItem(state, itemId, (i) => {
						if (colorType === 'highlightColor') {
							if (i.type !== 'captions') {
								throw new Error('Item is not a captions');
							}
							return {
								...(i as CaptionsItem),
								highlightColor: newColor,
							};
						}

						if (colorType === 'strokeColor') {
							if (i.type !== 'text' && i.type !== 'captions') {
								throw new Error('Item is not a text or caption');
							}
							return {
								...(i as TextItem | CaptionsItem),
								strokeColor: newColor,
							};
						}

						if (colorType === 'backgroundColor') {
							if (i.type !== 'text') {
								throw new Error('Item is not a text');
							}
							return {
								...(i as TextItem),
								background: {
									...(i.background as TextItemBackground),
									color: newColor,
								},
							};
						}

						if (
							i.type === 'text' ||
							i.type === 'solid' ||
							i.type === 'captions'
						) {
							return {
								...(i as TextItem | SolidItem | CaptionsItem),
								color: newColor,
							};
						}
						throw new Error('Invalid item type: ' + JSON.stringify(i));
					});
				},
				commitToUndoStack: false,
			});

			if (commitTimeoutRef.current) {
				clearTimeout(commitTimeoutRef.current);
			}

			const commit = () => {
				setState({
					update: (state) => state,
					commitToUndoStack: true,
				});
				pendingCommitRef.current = null;
			};

			pendingCommitRef.current = commit;

			commitTimeoutRef.current = setTimeout(() => {
				commit();
				commitTimeoutRef.current = null;
			}, 200);
		},
		[setState, itemId, colorType],
	);

	const parsedColor = useMemo(() => parseColor(cssColorToHex(color)), [color]);

	const label =
		colorType === 'highlightColor' ? t('highlightColor') : t('fillColor');
	const triggerAriaLabel =
		accessibilityLabel === 'Highlight color' ||
		accessibilityLabel === 'Fill color' ||
		accessibilityLabel === 'Color'
			? label
			: accessibilityLabel;

	return (
		<div className="w-full">
			<InspectorSubLabel>{label}</InspectorSubLabel>
			<ColorPicker value={parsedColor} onChange={onColorChange}>
				<ColorPicker.Trigger
					aria-label={triggerAriaLabel}
					className="border-editor-starter-surface-separator bg-editor-starter-surface-hover hover:bg-editor-starter-surface-active flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 transition-colors"
				>
					<ColorSwatch size="sm" className="rounded-sm" />
					<span className="text-editor-starter-text-muted font-mono text-xs">
						{cssColorToHex(color).toUpperCase()}
					</span>
				</ColorPicker.Trigger>
				<ColorPicker.Popover className="border-editor-starter-surface-separator bg-editor-starter-panel flex w-56 flex-col gap-2 rounded-xl border p-3 shadow-[0_22px_70px_var(--color-editor-starter-popover-shadow)]">
					<ColorArea
						aria-label={t('colorArea')}
						className="h-36 w-full rounded-lg"
						colorSpace="hsb"
						xChannel="saturation"
						yChannel="brightness"
					>
						<ColorArea.Thumb className="size-4 rounded-full border-2 border-white shadow-md" />
					</ColorArea>
					<ColorSlider
						aria-label={t('hueSlider')}
						channel="hue"
						colorSpace="hsb"
						className="px-0.5"
					>
						<ColorSlider.Track className="h-3 rounded-full">
							<ColorSlider.Thumb className="size-4 rounded-full border-2 border-white shadow-md" />
						</ColorSlider.Track>
					</ColorSlider>
					<ColorField aria-label={t('hexColor')}>
						<Label className="sr-only">{t('hex')}</Label>
						<ColorField.Group
							variant="secondary"
							className="border-editor-starter-surface-separator bg-editor-starter-surface-hover rounded-md border"
						>
							<ColorField.Prefix>
								<span className="text-editor-starter-text-faint pl-2 text-xs">
									#
								</span>
							</ColorField.Prefix>
							<ColorField.Input className="text-editor-starter-text bg-transparent py-1 pr-2 font-mono text-xs outline-none" />
						</ColorField.Group>
					</ColorField>
				</ColorPicker.Popover>
			</ColorPicker>
		</div>
	);
};

export const ColorInspector = memo(ColorInspectorUnmemoized);
