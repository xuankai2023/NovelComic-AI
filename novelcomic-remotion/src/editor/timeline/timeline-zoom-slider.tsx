import React, {useCallback} from 'react';
import {useTranslations} from 'next-intl';
import {MIN_TIMELINE_ZOOM} from '../constants';
import {MinusIcon} from '../icons/minus';
import {PlusIcon} from '../icons/plus';
import {Slider} from '../slider';
import {useTimelineSize} from './utils/use-timeline-size';
import {useTimelineZoom} from './utils/use-timeline-zoom';

const buttonStyle: React.CSSProperties = {
	paddingLeft: 4,
	paddingRight: 4,
	cursor: 'pointer',
};

export const TimelineZoomSlider: React.FC = () => {
	const t = useTranslations('editor.playback');
	const {zoom, setZoom} = useTimelineZoom();
	const {maxZoom, zoomStep} = useTimelineSize();

	const handleSliderChange = useCallback(
		(value: number) => {
			const realValue = value;
			setZoom(realValue);
		},
		[setZoom],
	);

	const handleZoomOut = useCallback(() => {
		setZoom((prev) => Math.max(prev - zoomStep, MIN_TIMELINE_ZOOM));
	}, [setZoom, zoomStep]);

	const handleZoomIn = useCallback(() => {
		setZoom((prev) => Math.min(prev + zoomStep, maxZoom));
	}, [setZoom, zoomStep, maxZoom]);

	return (
		<div className="flex items-center gap-2">
			<div onClick={handleZoomOut} style={buttonStyle}>
				<MinusIcon className="size-3 text-editor-starter-text" />
			</div>
			<Slider
				value={zoom}
				onValueChange={handleSliderChange}
				min={MIN_TIMELINE_ZOOM}
				max={maxZoom}
				step={zoomStep}
				title={t('zoom')}
			/>
			<div onClick={handleZoomIn} style={buttonStyle}>
				<PlusIcon className="size-3 text-editor-starter-text" />
			</div>
		</div>
	);
};
