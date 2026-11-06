import {Popover, Slider} from '@heroui/react';
import {ChevronDown, ChevronUp} from 'lucide-react';
import {useTranslations} from 'next-intl';
import {useCallback, useContext, useState} from 'react';
import {canvasRef} from '../canvas/canvas';
import {PreviewSizeContext} from '../preview-size';
import {calculateScale} from '../utils/calculate-canvas-transformation';
import {MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM} from '../utils/smooth-zoom';
import {useDimensions} from '../utils/use-context';

const ZOOM_PRESETS: Array<{value: 'fit' | number}> = [
	{value: 'fit'},
	{value: 0.5},
	{value: 1},
	{value: 2},
];

const clampZoom = (zoom: number) => {
	return Math.min(MAX_CANVAS_ZOOM, Math.max(MIN_CANVAS_ZOOM, zoom));
};

const normalizeSliderValue = (value: number | number[]) => {
	return Array.isArray(value) ? value[0] : value;
};

export const CanvasZoomControls: React.FC = () => {
	const t = useTranslations('editor.canvas.zoom');
	const {size, setSize} = useContext(PreviewSizeContext);
	const {compositionWidth, compositionHeight} = useDimensions();
	const [isOpen, setIsOpen] = useState(false);

	const getFitScale = useCallback(() => {
		const rect = canvasRef.current?.getBoundingClientRect();

		if (!rect) {
			return 1;
		}

		return calculateScale({
			canvasSize: rect,
			compositionWidth,
			compositionHeight,
			previewSize: 'auto',
		});
	}, [compositionHeight, compositionWidth]);

	const effectiveZoom = size.size === 'auto' ? getFitScale() : size.size;
	const zoomPercent = Math.round(effectiveZoom * 100);

	const setExplicitZoom = useCallback(
		(nextZoom: number) => {
			setSize((oldSize) => ({
				...oldSize,
				size: clampZoom(nextZoom),
			}));
		},
		[setSize],
	);

	const handleFit = useCallback(() => {
		setSize(() => ({
			translation: {
				x: 0,
				y: 0,
			},
			size: 'auto',
		}));
		setIsOpen(false);
	}, [setSize]);

	const handlePreset = useCallback(
		(value: number | 'fit') => {
			if (value === 'fit') {
				handleFit();
				return;
			}

			setExplicitZoom(value);
			setIsOpen(false);
		},
		[handleFit, setExplicitZoom],
	);

	const handleSliderChange = useCallback(
		(value: number | number[]) => {
			setExplicitZoom(normalizeSliderValue(value) / 100);
		},
		[setExplicitZoom],
	);

	return (
		<Popover isOpen={isOpen} onOpenChange={setIsOpen}>
			<Popover.Trigger
				className="border-editor-starter-surface-separator bg-editor-starter-inset text-editor-starter-text hover:bg-editor-starter-surface-hover/70 focus-visible:border-editor-starter-surface-subtle data-[focus-visible=true]:border-editor-starter-surface-subtle flex h-10 min-w-[106px] items-center justify-center gap-2 rounded-[14px] border px-2 transition-colors outline-none focus-visible:ring-0 focus-visible:outline-none data-[focus-visible=true]:ring-0 data-[focus-visible=true]:outline-none"
				aria-label={t('triggerAriaLabel')}
			>
				<span className="text-sm font-semibold tabular-nums">
					{zoomPercent}%
				</span>
				{isOpen ? (
					<ChevronUp className="text-editor-starter-text-muted size-4" />
				) : (
					<ChevronDown className="text-editor-starter-text-muted size-4" />
				)}
			</Popover.Trigger>
			<Popover.Content
				placement="bottom start"
				offset={10}
				containerPadding={0}
				className="border-editor-starter-surface-separator bg-editor-starter-panel text-editor-starter-text w-[320px] rounded-[12px] border shadow-[0_22px_70px_var(--color-editor-starter-popover-shadow)]"
			>
				<Popover.Dialog className="p-3 outline-none">
					<div className="text-editor-starter-text-faint text-[15px] font-medium">
						{t('panelTitle')}
					</div>
					<div className="mt-4 flex items-center gap-4">
						<Slider
							aria-label={t('sliderAriaLabel')}
							minValue={MIN_CANVAS_ZOOM * 100}
							maxValue={MAX_CANVAS_ZOOM * 100}
							step={1}
							value={zoomPercent}
							onChange={handleSliderChange}
							className="flex-1 gap-0"
						>
							<Slider.Track className="border-editor-starter-surface-separator bg-editor-starter-slider-track h-2 rounded-full border">
								<Slider.Fill className="bg-editor-starter-slider-fill rounded-full" />
								<Slider.Thumb className="after:bg-editor-starter-slider-thumb h-5 w-5 rounded-full bg-transparent after:size-4 after:rounded-full after:shadow-none data-[focus-visible=true]:ring-0" />
							</Slider.Track>
						</Slider>
						<div className="bg-editor-starter-surface-hover text-editor-starter-text flex h-auto min-w-[80px] items-center justify-center rounded-[8px] px-4 py-1 text-[16px] font-medium tabular-nums">
							{zoomPercent}%
						</div>
					</div>
					<div className="bg-editor-starter-surface-separator my-5 h-px" />
					<div className="space-y-1">
						{ZOOM_PRESETS.map((preset) => {
							const isActive =
								preset.value === 'fit'
									? size.size === 'auto'
									: Math.abs(effectiveZoom - preset.value) < 0.001;

							return (
								<button
									key={String(preset.value)}
									type="button"
									onClick={() => handlePreset(preset.value)}
									className={`flex w-full cursor-pointer items-center justify-between rounded-[12px] px-4 py-3 text-left transition-colors ${
										isActive
											? 'bg-editor-starter-surface-hover text-editor-starter-text'
											: 'text-editor-starter-text-muted hover:bg-editor-starter-surface-hover/70 hover:text-editor-starter-text'
									}`}
								>
									<span className="text-[15px] font-medium">
										{preset.value === 'fit'
											? t('presetFit')
											: t('presetPercent', {
													percent: Math.round(preset.value * 100),
												})}
									</span>
									<span className="text-editor-starter-text-faint text-sm">
										{preset.value === 'fit'
											? t('fit')
											: `${Math.round(preset.value * 100)}%`}
									</span>
								</button>
							);
						})}
					</div>
				</Popover.Dialog>
			</Popover.Content>
		</Popover>
	);
};
