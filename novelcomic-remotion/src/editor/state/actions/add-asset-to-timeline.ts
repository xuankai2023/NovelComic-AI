import {DropPosition} from '../../assets/drop-position';
import {
	canMakeItemFromAsset,
	makeItemFromAsset,
} from '../../items/make-item-from-asset';
import {isTimelineEmpty} from '../../utils/is-timeline-empty';
import {EditorState} from '../types';
import {addItem} from './add-item';

export const addAssetToTimeline = ({
	state,
	assetId,
	currentFrame,
	dropPosition,
	resizeCompositionIfEmpty,
}: {
	state: EditorState;
	assetId: string;
	currentFrame: number;
	dropPosition: DropPosition | null;
	resizeCompositionIfEmpty: boolean;
}): EditorState => {
	const asset = state.undoableState.assets[assetId];
	if (!asset || !canMakeItemFromAsset(asset)) {
		return state;
	}

	const item = makeItemFromAsset({
		asset,
		currentFrame,
		fps: state.undoableState.fps,
		compositionWidth: state.undoableState.compositionWidth,
		compositionHeight: state.undoableState.compositionHeight,
		dropPosition,
	});
	const withItem = addItem({
		state,
		item,
		select: true,
		position: {type: 'front'},
	});

	if (
		!resizeCompositionIfEmpty ||
		!isTimelineEmpty(state.undoableState.tracks)
	) {
		return withItem;
	}

	return {
		...withItem,
		undoableState: {
			...withItem.undoableState,
			compositionWidth: item.width,
			compositionHeight: item.height,
		},
	};
};
