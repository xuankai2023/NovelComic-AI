/**
 * SampleRingOverlay. The ring is a fixed screen size, centered on the pointer.
 * New sample on the top half, the color from before the drag on the bottom half.
 */
export const SAMPLE_RING_SIZE = 116;
export const SAMPLE_RING_INSET = 15;
export const SAMPLE_RING_HALO = 24;
export const SAMPLE_RING_BAND = 16;

export const sampleRingRadius = () => (SAMPLE_RING_SIZE - SAMPLE_RING_INSET * 2) / 2;
