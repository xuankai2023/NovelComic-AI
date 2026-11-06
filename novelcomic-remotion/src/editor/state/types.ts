import type {AdjustmentLayer, LayerGroup, PenPath} from '../advanced/types';
import {AssetState, EditorStarterAsset} from '../assets/assets';
import {CanvasSnapPoint} from '../canvas/snap/canvas-snap-types';
import {CaptioningTask} from '../captioning/caption-state';
import type {ComicEditLayer} from '../comic/manual-layer-types';
import type {
	ComicTrackRole,
	Shot,
	TrackSemantic,
	VoiceProfile,
} from '../comic/types';
import type {AdvancedProjectState} from '../composition/types';
import {EditorStarterItem} from '../items/item-type';
import {TextItemHoverPreview} from '../items/text/override-text-item-with-hover-preview';
import {ItemBeingTrimmed} from '../items/trim-indicator';
import type {PropertyGraphV1} from '../property/types';
import {RenderingTask} from '../rendering/render-state';
import {SnapPoint} from '../timeline/utils/snap-points';

// The shape of the state is explained here:
// https://remotion.dev/docs/editor-starter/state-management

export type TrackType = {
	items: string[];
	id: string;
	hidden: boolean;
	muted: boolean;
	locked?: boolean;
	name?: string;
	shotId?: string;
	semantic?: TrackSemantic;
	/** Explicit comic role; absent values remain valid for legacy projects. */
	role?: ComicTrackRole;
};

type DeletedAsset = {
	remoteUrl: string | null;
	remoteFileKey: string | null;
	assetId: string;
	statusAtDeletion: AssetState;
};

// Undoable state: https://remotion.dev/docs/editor-starter/state-management#undoable-state
export type UndoableState = {
	tracks: TrackType[];
	assets: Record<string, EditorStarterAsset>;
	items: Record<string, EditorStarterItem>;
	fps: number;
	compositionWidth: number;
	compositionHeight: number;
	deletedAssets: DeletedAsset[];
	schemaVersion?: number;
	shots?: Shot[];
	comicEditLayers?: Record<string, ComicEditLayer>;
	voiceProfiles?: Record<string, VoiceProfile>;
	layerGroups?: Record<string, LayerGroup>;
	adjustmentLayers?: Record<string, AdjustmentLayer>;
	penPaths?: Record<string, PenPath>;
	advanced?: AdvancedProjectState;
	propertyGraph?: PropertyGraphV1;
};

export type EditorState = {
	undoableState: UndoableState;
	selectedItems: string[];
	textItemEditing: string | null;
	textItemHoverPreview: TextItemHoverPreview | null;
	itemSelectedForCrop: string | null;
	renderingTasks: RenderingTask[];
	captioningTasks: CaptioningTask[];
	initialized: boolean;
	itemsBeingTrimmed: ItemBeingTrimmed[];
	loop: boolean;
	timelineHeight: number;
	assetStatus: Record<string, AssetState>;
	isSnappingEnabled: boolean;
	autoKeyEnabled: boolean;
	activeSnapPoint: SnapPoint | null;
	activeCanvasSnapPoints: CanvasSnapPoint[];
};
