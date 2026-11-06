'use client';

import React from 'react';
import type {ToolOverlayState} from '../types';
import {SAMPLE_RING_BAND, SAMPLE_RING_HALO, SAMPLE_RING_SIZE, sampleRingRadius} from './sample-ring-metrics';

const css = (color: {r: number; g: number; b: number}) => `rgb(${color.r}, ${color.g}, ${color.b})`;

/** Display-only comparison ring. It does not take hits. */
export const SampleRing: React.FC<{
	ring: NonNullable<ToolOverlayState['sampleRing']>;
	scale: number;
}> = ({ring, scale}) => {
	const clip = React.useId().replace(/:/g, '');
	const radius = sampleRingRadius();
	const center = SAMPLE_RING_SIZE / 2;
	const left = ring.x * scale - center;
	const top = ring.y * scale - center;
	return (
		<svg
			aria-hidden="true"
			className="pointer-events-none absolute overflow-visible"
			data-testid="eyedropper-sample-ring"
			height={SAMPLE_RING_SIZE}
			style={{left, top}}
			width={SAMPLE_RING_SIZE}
		>
			<circle cx={center} cy={center} fill="none" r={radius} stroke="rgb(115, 115, 115)" strokeWidth={SAMPLE_RING_HALO} />
			<clipPath id={`${clip}-top`}>
				<rect height={center} width={SAMPLE_RING_SIZE} x="0" y="0" />
			</clipPath>
			<clipPath id={`${clip}-bottom`}>
				<rect height={center} width={SAMPLE_RING_SIZE} x="0" y={center} />
			</clipPath>
			<circle
				clipPath={`url(#${clip}-top)`}
				cx={center}
				cy={center}
				fill="none"
				r={radius}
				stroke={css(ring.sampled)}
				strokeWidth={SAMPLE_RING_BAND}
			/>
			<circle
				clipPath={`url(#${clip}-bottom)`}
				cx={center}
				cy={center}
				fill="none"
				r={radius}
				stroke={css(ring.original)}
				strokeWidth={SAMPLE_RING_BAND}
			/>
		</svg>
	);
};
