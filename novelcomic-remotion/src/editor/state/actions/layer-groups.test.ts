import {describe, expect, it} from 'vitest';
import {getInitialState} from '../initial-state';
import {
	createLayerGroup,
	isItemOnLockedLayerGroup,
	toggleLayerGroupLocked,
} from './layer-groups';

describe('layer groups', () => {
	it('groups tracks and propagates locked state to items', () => {
		const initial = getInitialState();
		const state = {
			...initial,
			undoableState: {
				...initial.undoableState,
				tracks: [
					{
						id: 'track-1',
						items: ['item-1'],
						hidden: false,
						muted: false,
					},
				],
				items: {
					'item-1': {
						id: 'item-1',
						type: 'solid' as const,
						from: 0,
						durationInFrames: 10,
						left: 0,
						top: 0,
						width: 10,
						height: 10,
						opacity: 1,
						isDraggingInTimeline: false,
						borderRadius: 0,
						rotation: 0,
						color: '#fff',
						keepAspectRatio: true,
						fadeInDurationInSeconds: 0,
						fadeOutDurationInSeconds: 0,
					},
				},
			},
		};
		const grouped = createLayerGroup(state, {
			id: 'group-1',
			name: 'Group',
			trackIds: ['track-1'],
			visible: true,
			locked: false,
			collapsed: false,
		});
		const locked = toggleLayerGroupLocked(grouped, 'group-1');
		expect(isItemOnLockedLayerGroup(locked.undoableState, 'item-1')).toBe(true);
	});
});
