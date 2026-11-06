import {Button} from '@heroui/react';
import {
	Blend,
	Crop,
	FileText,
	Film,
	FolderOpen,
	Image,
	Layers3,
	LayoutGrid,
	Music4,
	PaintBucket,
	PenTool,
	Sparkles,
	Square,
	Type,
	X,
} from 'lucide-react';
import {useTranslations} from 'next-intl';
import React, {useEffect, useMemo, useState} from 'react';
import {GenerateCaptionContent} from '../captioning/caption-section';
import {scrollbarStyle} from '../constants';
import {
	FEATURE_ALIGNMENT_CONTROL,
	FEATURE_AUDIO_FADE_CONTROL,
	FEATURE_BORDER_RADIUS_CONTROL,
	FEATURE_CAPTION_STYLE_CONTROL,
	FEATURE_CAPTIONS_PAGE_DURATION_CONTROL,
	FEATURE_COLOR_CONTROL,
	FEATURE_CROP_CONTROL,
	FEATURE_CROPPING,
	FEATURE_DIMENSIONS_CONTROL,
	FEATURE_FONT_FAMILY_CONTROL,
	FEATURE_FONT_STYLE_CONTROL,
	FEATURE_OPACITY_CONTROL,
	FEATURE_PLAYBACKRATE_CONTROL,
	FEATURE_POSITION_CONTROL,
	FEATURE_ROTATION_CONTROL,
	FEATURE_SOURCE_CONTROL,
	FEATURE_TEXT_ALIGNMENT_CONTROL,
	FEATURE_TEXT_BACKGROUND_CONTROL,
	FEATURE_TEXT_DIRECTION_CONTROL,
	FEATURE_TEXT_FONT_SIZE_CONTROL,
	FEATURE_TEXT_LETTER_SPACING_CONTROL,
	FEATURE_TEXT_LINE_HEIGHT_CONTROL,
	FEATURE_TEXT_MAX_LINES_CONTROL,
	FEATURE_TEXT_STROKE_COLOR_CONTROL,
	FEATURE_TEXT_STROKE_WIDTH_CONTROL,
	FEATURE_TEXT_VALUE_CONTROL,
	FEATURE_TOKENS_CONTROL,
	FEATURE_VISUAL_FADE_CONTROL,
	FEATURE_VOLUME_CONTROL,
} from '../flags';
import {AudioItem} from '../items/audio/audio-item-type';
import {
	CaptionsItem,
	normalizeCaptionStyle,
} from '../items/captions/captions-item-type';
import {GifItem} from '../items/gif/gif-item-type';
import {ImageItem} from '../items/image/image-item-type';
import {SolidItem} from '../items/solid/solid-item-type';
import {TextItem} from '../items/text/text-item-type';
import {VideoItem} from '../items/video/video-item-type';
import {clsx} from '../utils/clsx';
import {useItem} from '../utils/use-context';
import {ColorInspector} from './color-inspector';
import {AlignmentControls} from './controls/alignment-controls';
import {AudioFadeControls} from './controls/audio-fade-controls';
import {BlendModeControls} from './controls/blend-mode-controls';
import {BorderRadiusControl} from './controls/border-radius-controls';
import {CaptionStyleControl} from './controls/caption-controls/caption-style-control';
import {PageDurationControls} from './controls/caption-controls/page-duration-controls';
import {TokensContent} from './controls/caption-controls/tokens-controls';
import {CropControls} from './controls/crop-controls';
import {DimensionsControls} from './controls/dimensions-controls';
import {FadeControls} from './controls/fade-controls';
import {FontFamilyControl} from './controls/font-family-controls/font-family-controls';
import {FontSizeControls} from './controls/font-size-controls';
import {FontStyleControls} from './controls/font-style-controls/font-style-controls';
import {LetterSpacingControls} from './controls/letter-spacing-controls';
import {LineHeightControls} from './controls/line-height-controls';
import {MaskControls} from './controls/mask-controls';
import {MaxLinesControls} from './controls/max-lines-controls';
import {MotionControls} from './controls/motion-controls';
import {OpacityControls} from './controls/opacity-controls';
import {PlaybackRateControls} from './controls/playback-rate-controls';
import {PositionControl} from './controls/position-control';
import {RotationControl} from './controls/rotation-controls';
import {TransformPropertyInspector} from './controls/transform-property-inspector';
import {SourceInfoContent} from './controls/source-info/source-info';
import {StrokeWidthControls} from './controls/stroke-width-controls';
import {TextAlignmentControls} from './controls/text-alignment-controls';
import {TextBackgroundContent} from './controls/text-background-controls/text-background-controls';
import {TextDirectionControls} from './controls/text-direction-controls';
import {TextValueControls} from './controls/text-value-controls/text-value-controls';
import {VolumeControls} from './controls/volume-controls';

type DockIcon = React.ComponentType<{className?: string}>;

type InspectorDockSection = {
	id: string;
	label: string;
	icon: DockIcon;
	content: React.ReactNode;
};

type SectionLabelKey =
	| 'source'
	| 'layout'
	| 'motion'
	| 'fill'
	| 'composite'
	| 'crop'
	| 'fade'
	| 'video'
	| 'audio'
	| 'captions'
	| 'typography'
	| 'stroke'
	| 'background'
	| 'tokens'
	| 'gif';

type SectionTranslator = (key: SectionLabelKey) => string;

const sectionContentClassName = 'flex flex-col gap-3';

const SourceSection = ({
	item,
}: {
	item: VideoItem | ImageItem | GifItem | AudioItem;
}) => {
	return (
		<div className={sectionContentClassName}>
			<SourceInfoContent item={item} />
		</div>
	);
};

const LayoutSection = ({
	itemId,
	rotation,
	item,
}: {
	itemId: string;
	rotation: number;
	item?: ImageItem;
}) => {
	return (
		<div className={sectionContentClassName}>
			{item ? <TransformPropertyInspector item={item} /> : null}
			{FEATURE_ALIGNMENT_CONTROL ? <AlignmentControls itemId={itemId} /> : null}
			{FEATURE_POSITION_CONTROL && !item ? <PositionControl itemId={itemId} /> : null}
			{FEATURE_DIMENSIONS_CONTROL ? (
				<DimensionsControls itemId={itemId} />
			) : null}
			{FEATURE_ROTATION_CONTROL && !item ? (
				<RotationControl rotation={rotation} itemId={itemId} />
			) : null}
		</div>
	);
};

const FillSection = ({children}: {children: React.ReactNode}) => {
	return <div className={sectionContentClassName}>{children}</div>;
};

const CompositeSection = ({item}: {item: ImageItem}) => {
	return (
		<div className={sectionContentClassName}>
			<BlendModeControls item={item} />
			<MaskControls item={item} />
		</div>
	);
};

const FadeSection = ({
	itemId,
	durationInFrames,
	fadeInDurationInSeconds,
	fadeOutDurationInSeconds,
}: {
	itemId: string;
	durationInFrames: number;
	fadeInDurationInSeconds: number;
	fadeOutDurationInSeconds: number;
}) => {
	return (
		<div className={sectionContentClassName}>
			<FadeControls
				fadeInDuration={fadeInDurationInSeconds}
				fadeOutDuration={fadeOutDurationInSeconds}
				itemId={itemId}
				durationInFrames={durationInFrames}
			/>
		</div>
	);
};

const CropSection = ({itemId}: {itemId: string}) => {
	return (
		<div className={sectionContentClassName}>
			<CropControls itemId={itemId} />
		</div>
	);
};

const TypographySection = ({item}: {item: TextItem | CaptionsItem}) => {
	return (
		<div className={sectionContentClassName}>
			{FEATURE_FONT_FAMILY_CONTROL ? (
				<FontFamilyControl fontFamily={item.fontFamily} itemId={item.id} />
			) : null}
			{FEATURE_FONT_STYLE_CONTROL ? (
				<FontStyleControls
					fontFamily={item.fontFamily}
					fontStyle={item.fontStyle}
					itemId={item.id}
				/>
			) : null}
			{FEATURE_TEXT_FONT_SIZE_CONTROL ? (
				<FontSizeControls
					fontSize={item.fontSize}
					itemId={item.id}
					itemType={item.type === 'captions' ? 'captions' : 'text'}
				/>
			) : null}
			<div className="flex flex-row gap-2">
				{FEATURE_TEXT_LINE_HEIGHT_CONTROL ? (
					<LineHeightControls lineHeight={item.lineHeight} itemId={item.id} />
				) : null}
				{FEATURE_TEXT_LETTER_SPACING_CONTROL ? (
					<LetterSpacingControls
						letterSpacing={item.letterSpacing}
						itemId={item.id}
					/>
				) : null}
			</div>
			{item.type === 'text' && FEATURE_TEXT_VALUE_CONTROL ? (
				<TextValueControls
					text={item.text}
					itemId={item.id}
					direction={item.direction}
					align={item.align}
				/>
			) : null}
			<div className="flex flex-row gap-2">
				{FEATURE_TEXT_ALIGNMENT_CONTROL ? (
					<TextAlignmentControls align={item.align} itemId={item.id} />
				) : null}
				{FEATURE_TEXT_DIRECTION_CONTROL ? (
					<TextDirectionControls direction={item.direction} itemId={item.id} />
				) : null}
			</div>
		</div>
	);
};

const TextStrokeSection = ({item}: {item: TextItem | CaptionsItem}) => {
	return (
		<div className={sectionContentClassName}>
			{FEATURE_TEXT_STROKE_WIDTH_CONTROL ? (
				<StrokeWidthControls strokeWidth={item.strokeWidth} itemId={item.id} />
			) : null}
			{FEATURE_TEXT_STROKE_COLOR_CONTROL ? (
				<ColorInspector
					color={item.strokeColor}
					itemId={item.id}
					colorType="strokeColor"
					accessibilityLabel="Stroke color"
				/>
			) : null}
		</div>
	);
};

const VideoSection = ({item}: {item: VideoItem}) => {
	return (
		<div className={sectionContentClassName}>
			{FEATURE_PLAYBACKRATE_CONTROL ? (
				<PlaybackRateControls
					playbackRate={item.playbackRate}
					itemId={item.id}
					assetId={item.assetId}
				/>
			) : null}
			{FEATURE_VISUAL_FADE_CONTROL ? (
				<FadeControls
					fadeInDuration={item.fadeInDurationInSeconds}
					fadeOutDuration={item.fadeOutDurationInSeconds}
					itemId={item.id}
					durationInFrames={item.durationInFrames}
				/>
			) : null}
		</div>
	);
};

const AudioSection = ({item}: {item: VideoItem | AudioItem}) => {
	return (
		<div className={sectionContentClassName}>
			{FEATURE_VOLUME_CONTROL ? (
				<VolumeControls
					decibelAdjustment={item.decibelAdjustment}
					itemId={item.id}
				/>
			) : null}
			{FEATURE_AUDIO_FADE_CONTROL ? (
				<AudioFadeControls
					fadeInDuration={item.audioFadeInDurationInSeconds}
					fadeOutDuration={item.audioFadeOutDurationInSeconds}
					itemId={item.id}
					durationInFrames={item.durationInFrames}
				/>
			) : null}
			{item.type === 'audio' && FEATURE_PLAYBACKRATE_CONTROL ? (
				<PlaybackRateControls
					playbackRate={item.playbackRate}
					itemId={item.id}
					assetId={item.assetId}
				/>
			) : null}
		</div>
	);
};

const CaptionsSection = ({item}: {item: CaptionsItem}) => {
	return (
		<div className={sectionContentClassName}>
			{FEATURE_CAPTION_STYLE_CONTROL ? (
				<CaptionStyleControl
					captionStyle={normalizeCaptionStyle(item.captionStyle)}
					itemId={item.id}
				/>
			) : null}
			{FEATURE_CAPTIONS_PAGE_DURATION_CONTROL ? (
				<PageDurationControls
					pageDurationInMilliseconds={item.pageDurationInMilliseconds}
					itemId={item.id}
				/>
			) : null}
			{FEATURE_TEXT_MAX_LINES_CONTROL ? (
				<MaxLinesControls maxLines={item.maxLines} itemId={item.id} />
			) : null}
		</div>
	);
};

const TokensSection = ({item}: {item: CaptionsItem}) => {
	return (
		<div className={sectionContentClassName}>
			<TokensContent item={item} />
		</div>
	);
};

const CaptionActionSection = ({item}: {item: VideoItem | AudioItem}) => {
	return (
		<div className={sectionContentClassName}>
			<GenerateCaptionContent item={item} />
		</div>
	);
};

const getSectionsForItem = (
	item:
		| AudioItem
		| CaptionsItem
		| GifItem
		| ImageItem
		| SolidItem
		| TextItem
		| VideoItem,
	t: SectionTranslator,
): InspectorDockSection[] => {
	if (item.type === 'image') {
		return [
			FEATURE_SOURCE_CONTROL
				? {
						id: 'source',
						label: t('source'),
						icon: FolderOpen,
						content: <SourceSection item={item} />,
					}
				: null,
			{
				id: 'layout',
				label: t('layout'),
				icon: LayoutGrid,
				content: (
					<LayoutSection
						itemId={item.id}
						rotation={item.rotation}
						item={item}
					/>
				),
			},
			{
				id: 'motion',
				label: t('motion'),
				icon: Sparkles,
				content: <MotionControls item={item} />,
			},
			{
				id: 'fill',
				label: t('fill'),
				icon: PaintBucket,
				content: (
					<FillSection>
						{FEATURE_BORDER_RADIUS_CONTROL ? (
							<BorderRadiusControl
								borderRadius={item.borderRadius}
								borderRadiusType="fill"
								itemId={item.id}
							/>
						) : null}
					</FillSection>
				),
			},
			{
				id: 'composite',
				label: t('composite'),
				icon: Layers3,
				content: <CompositeSection item={item} />,
			},
			FEATURE_CROPPING && FEATURE_CROP_CONTROL
				? {
						id: 'crop',
						label: t('crop'),
						icon: Crop,
						content: <CropSection itemId={item.id} />,
					}
				: null,
			FEATURE_VISUAL_FADE_CONTROL
				? {
						id: 'fade',
						label: t('fade'),
						icon: Blend,
						content: (
							<FadeSection
								itemId={item.id}
								durationInFrames={item.durationInFrames}
								fadeInDurationInSeconds={item.fadeInDurationInSeconds}
								fadeOutDurationInSeconds={item.fadeOutDurationInSeconds}
							/>
						),
					}
				: null,
		].filter(Boolean) as InspectorDockSection[];
	}

	if (item.type === 'video') {
		return [
			FEATURE_SOURCE_CONTROL
				? {
						id: 'source',
						label: t('source'),
						icon: FolderOpen,
						content: <SourceSection item={item} />,
					}
				: null,
			{
				id: 'layout',
				label: t('layout'),
				icon: LayoutGrid,
				content: <LayoutSection itemId={item.id} rotation={item.rotation} />,
			},
			{
				id: 'fill',
				label: t('fill'),
				icon: PaintBucket,
				content: (
					<FillSection>
						{FEATURE_OPACITY_CONTROL ? (
							<OpacityControls opacity={item.opacity} itemId={item.id} />
						) : null}
						{FEATURE_BORDER_RADIUS_CONTROL ? (
							<BorderRadiusControl
								borderRadius={item.borderRadius}
								borderRadiusType="fill"
								itemId={item.id}
							/>
						) : null}
					</FillSection>
				),
			},
			FEATURE_CROPPING && FEATURE_CROP_CONTROL
				? {
						id: 'crop',
						label: t('crop'),
						icon: Crop,
						content: <CropSection itemId={item.id} />,
					}
				: null,
			{
				id: 'video',
				label: t('video'),
				icon: Film,
				content: <VideoSection item={item} />,
			},
			{
				id: 'audio',
				label: t('audio'),
				icon: Music4,
				content: <AudioSection item={item} />,
			},
			{
				id: 'captions',
				label: t('captions'),
				icon: FileText,
				content: <CaptionActionSection item={item} />,
			},
		].filter(Boolean) as InspectorDockSection[];
	}

	if (item.type === 'audio') {
		return [
			FEATURE_SOURCE_CONTROL
				? {
						id: 'source',
						label: t('source'),
						icon: FolderOpen,
						content: <SourceSection item={item} />,
					}
				: null,
			{
				id: 'audio',
				label: t('audio'),
				icon: Music4,
				content: <AudioSection item={item} />,
			},
			{
				id: 'captions',
				label: t('captions'),
				icon: FileText,
				content: <CaptionActionSection item={item} />,
			},
		].filter(Boolean) as InspectorDockSection[];
	}

	if (item.type === 'text') {
		return [
			{
				id: 'layout',
				label: t('layout'),
				icon: LayoutGrid,
				content: <LayoutSection itemId={item.id} rotation={item.rotation} />,
			},
			{
				id: 'typography',
				label: t('typography'),
				icon: Type,
				content: <TypographySection item={item} />,
			},
			{
				id: 'fill',
				label: t('fill'),
				icon: PaintBucket,
				content: (
					<FillSection>
						{FEATURE_OPACITY_CONTROL ? (
							<OpacityControls opacity={item.opacity} itemId={item.id} />
						) : null}
						{FEATURE_COLOR_CONTROL ? (
							<ColorInspector
								color={item.color}
								itemId={item.id}
								colorType="color"
								accessibilityLabel="Fill color"
							/>
						) : null}
					</FillSection>
				),
			},
			{
				id: 'stroke',
				label: t('stroke'),
				icon: PenTool,
				content: <TextStrokeSection item={item} />,
			},
			FEATURE_TEXT_BACKGROUND_CONTROL
				? {
						id: 'background',
						label: t('background'),
						icon: Square,
						content: (
							<div className={sectionContentClassName}>
								<TextBackgroundContent item={item} />
							</div>
						),
					}
				: null,
			FEATURE_VISUAL_FADE_CONTROL
				? {
						id: 'fade',
						label: t('fade'),
						icon: Blend,
						content: (
							<FadeSection
								itemId={item.id}
								durationInFrames={item.durationInFrames}
								fadeInDurationInSeconds={item.fadeInDurationInSeconds}
								fadeOutDurationInSeconds={item.fadeOutDurationInSeconds}
							/>
						),
					}
				: null,
		].filter(Boolean) as InspectorDockSection[];
	}

	if (item.type === 'captions') {
		return [
			{
				id: 'layout',
				label: t('layout'),
				icon: LayoutGrid,
				content: <LayoutSection itemId={item.id} rotation={item.rotation} />,
			},
			{
				id: 'typography',
				label: t('typography'),
				icon: Type,
				content: <TypographySection item={item} />,
			},
			FEATURE_OPACITY_CONTROL
				? {
						id: 'fill',
						label: t('fill'),
						icon: PaintBucket,
						content: (
							<FillSection>
								<OpacityControls opacity={item.opacity} itemId={item.id} />
								<div className="flex flex-row gap-2">
									{FEATURE_COLOR_CONTROL ? (
										<ColorInspector
											color={item.color}
											itemId={item.id}
											colorType="color"
											accessibilityLabel="Fill color"
										/>
									) : null}
									{FEATURE_COLOR_CONTROL ? (
										<ColorInspector
											color={item.highlightColor}
											itemId={item.id}
											colorType="highlightColor"
											accessibilityLabel="Highlight color"
										/>
									) : null}
								</div>
							</FillSection>
						),
					}
				: null,
			{
				id: 'stroke',
				label: t('stroke'),
				icon: PenTool,
				content: <TextStrokeSection item={item} />,
			},
			{
				id: 'captions',
				label: t('captions'),
				icon: FileText,
				content: <CaptionsSection item={item} />,
			},
			FEATURE_TOKENS_CONTROL
				? {
						id: 'tokens',
						label: t('tokens'),
						icon: FileText,
						content: <TokensSection item={item} />,
					}
				: null,
		].filter(Boolean) as InspectorDockSection[];
	}

	if (item.type === 'solid') {
		return [
			{
				id: 'layout',
				label: t('layout'),
				icon: LayoutGrid,
				content: <LayoutSection itemId={item.id} rotation={item.rotation} />,
			},
			{
				id: 'fill',
				label: t('fill'),
				icon: PaintBucket,
				content: (
					<FillSection>
						{FEATURE_OPACITY_CONTROL ? (
							<OpacityControls opacity={item.opacity} itemId={item.id} />
						) : null}
						{FEATURE_COLOR_CONTROL ? (
							<ColorInspector
								color={item.color}
								itemId={item.id}
								colorType="color"
								accessibilityLabel="Fill color"
							/>
						) : null}
						{FEATURE_BORDER_RADIUS_CONTROL ? (
							<BorderRadiusControl
								borderRadius={item.borderRadius}
								borderRadiusType="fill"
								itemId={item.id}
							/>
						) : null}
					</FillSection>
				),
			},
			FEATURE_VISUAL_FADE_CONTROL
				? {
						id: 'fade',
						label: t('fade'),
						icon: Blend,
						content: (
							<FadeSection
								itemId={item.id}
								durationInFrames={item.durationInFrames}
								fadeInDurationInSeconds={item.fadeInDurationInSeconds}
								fadeOutDurationInSeconds={item.fadeOutDurationInSeconds}
							/>
						),
					}
				: null,
		].filter(Boolean) as InspectorDockSection[];
	}

	return [
		FEATURE_SOURCE_CONTROL
			? {
					id: 'source',
					label: t('source'),
					icon: FolderOpen,
					content: <SourceSection item={item} />,
				}
			: null,
		{
			id: 'layout',
			label: t('layout'),
			icon: LayoutGrid,
			content: <LayoutSection itemId={item.id} rotation={item.rotation} />,
		},
		{
			id: 'fill',
			label: t('fill'),
			icon: PaintBucket,
			content: (
				<FillSection>
					{FEATURE_OPACITY_CONTROL ? (
						<OpacityControls opacity={item.opacity} itemId={item.id} />
					) : null}
					{FEATURE_BORDER_RADIUS_CONTROL ? (
						<BorderRadiusControl
							borderRadius={item.borderRadius}
							borderRadiusType="fill"
							itemId={item.id}
						/>
					) : null}
				</FillSection>
			),
		},
		{
			id: 'gif',
			label: t('gif'),
			icon: Image,
			content: (
				<div className={sectionContentClassName}>
					{FEATURE_PLAYBACKRATE_CONTROL ? (
						<PlaybackRateControls
							playbackRate={item.playbackRate}
							itemId={item.id}
							assetId={item.assetId}
						/>
					) : null}
				</div>
			),
		},
		FEATURE_CROPPING && FEATURE_CROP_CONTROL
			? {
					id: 'crop',
					label: t('crop'),
					icon: Crop,
					content: <CropSection itemId={item.id} />,
				}
			: null,
		FEATURE_VISUAL_FADE_CONTROL
			? {
					id: 'fade',
					label: t('fade'),
					icon: Blend,
					content: (
						<FadeSection
							itemId={item.id}
							durationInFrames={item.durationInFrames}
							fadeInDurationInSeconds={item.fadeInDurationInSeconds}
							fadeOutDurationInSeconds={item.fadeOutDurationInSeconds}
						/>
					),
				}
			: null,
	].filter(Boolean) as InspectorDockSection[];
};

const InspectorDockPanel: React.FC<{
	label: string;
	onClose: () => void;
	children: React.ReactNode;
}> = ({label, onClose, children}) => {
	return (
		<div className="border-r-editor-starter-surface-separator bg-editor-starter-panel text-editor-starter-text flex h-full w-[300px] flex-col border-r p-3 shadow-[0_24px_60px_var(--color-editor-starter-popover-shadow)]">
			<div className="flex shrink-0 items-start justify-between">
				<div className="pt-1 text-[16px] font-semibold tracking-tight">
					{label}
				</div>
				<Button
					variant="ghost"
					onPress={onClose}
					className="text-editor-starter-text-muted hover:bg-editor-starter-surface-hover hover:text-editor-starter-text h-6 w-6 rounded-[2px] px-0 shadow-none"
				>
					<X className="size-4" />
				</Button>
			</div>
			<div className="bg-editor-starter-surface-separator mt-3 h-px w-full shrink-0" />
			<div
				className="mt-3 min-h-0 flex-1 overflow-y-auto"
				style={scrollbarStyle}
			>
				{children}
			</div>
		</div>
	);
};

export const InspectorDock: React.FC<{itemId: string}> = ({itemId}) => {
	const tSections = useTranslations('editor.inspector.sections');
	const rawItem = useItem(itemId);
	const item = rawItem as
		| AudioItem
		| CaptionsItem
		| GifItem
		| ImageItem
		| SolidItem
		| TextItem
		| VideoItem;
	const [activeSection, setActiveSection] = useState<string | null>(null);

	const sections = useMemo(() => {
		if (!rawItem) return [];
		return getSectionsForItem(item, tSections);
	}, [rawItem, item, tSections]);

	useEffect(() => {
		if (!activeSection) {
			return;
		}

		const hasActiveSection = sections.some(
			(section) => section.id === activeSection,
		);

		if (!hasActiveSection) {
			setActiveSection(null);
		}
	}, [activeSection, sections]);

	if (!rawItem) {
		return null;
	}

	return (
		<div className="relative z-30 flex h-full shrink-0 items-stretch justify-start">
			<div className="pointer-events-auto flex h-full items-stretch">
				<div className="border-r-editor-starter-surface-separator bg-editor-starter-panel flex w-[80px] flex-col gap-3 border-r p-1.5 pt-5">
					{sections.map((section) => {
						const isActive = activeSection === section.id;
						return (
							<Button
								key={section.id}
								variant="ghost"
								onPress={() => {
									setActiveSection((prev) =>
										prev === section.id ? null : section.id,
									);
								}}
								className={clsx(
									'text-editor-starter-text-faint h-auto w-full flex-col gap-1 rounded-[8px] px-2 py-1.5 shadow-none transition-colors',
									'hover:bg-editor-starter-surface-hover hover:text-editor-starter-text',
									isActive &&
										'bg-editor-starter-surface-active text-editor-starter-text',
								)}
							>
								<section.icon className="size-[20px]" />
								<span className="text-[12px] leading-tight font-semibold">
									{section.label}
								</span>
							</Button>
						);
					})}
				</div>

				{activeSection ? (
					<InspectorDockPanel
						label={
							sections.find((section) => section.id === activeSection)?.label ??
							''
						}
						onClose={() => setActiveSection(null)}
					>
						{sections.find((section) => section.id === activeSection)?.content}
					</InspectorDockPanel>
				) : null}
			</div>
		</div>
	);
};
