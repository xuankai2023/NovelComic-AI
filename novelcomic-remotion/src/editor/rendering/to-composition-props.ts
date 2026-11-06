import type {EditorStarterAsset} from '../assets/assets';
import type {Shot} from '../comic/types';
import {
	createEmptyAdvancedProjectState,
	type AdvancedProjectState,
} from '../composition/types';
import type {EditorStarterItem} from '../items/item-type';
import {validatePropertyGraph} from '../property/evaluate-property';
import {materializeLegacyMotion} from '../property/materialize-motion';
import type {PropertyGraphV1} from '../property/types';
import type {TrackType, UndoableState} from '../state/types';
import {collectFontInfoFromItems} from '../utils/text/collect-font-info-from-items';
import type {FontInfosContextType} from '../utils/text/font-info';

export type ComicCompositionProps = {
	tracks: TrackType[];
	items: Record<string, EditorStarterItem>;
	assets: Record<string, EditorStarterAsset>;
	shots: Shot[];
	compositionWidth: number;
	compositionHeight: number;
	fps: number;
	fontInfos: FontInfosContextType;
	advanced: AdvancedProjectState;
	propertyGraph?: PropertyGraphV1;
};

export type CompositionProjectSource = Pick<
	UndoableState,
	| 'tracks'
	| 'items'
	| 'assets'
	| 'compositionWidth'
	| 'compositionHeight'
	| 'fps'
> & {
	shots?: Shot[];
	advanced?: AdvancedProjectState;
	propertyGraph?: PropertyGraphV1;
};

export const toCompositionProps = (
	project: CompositionProjectSource,
): ComicCompositionProps => {
	if (project.propertyGraph) {
		validatePropertyGraph({
			graph: project.propertyGraph,
			items: project.items,
			shots: project.shots ?? [],
			advanced: project.advanced,
		});
	}
	const materialized = materializeLegacyMotion(project);
	return {
		tracks: materialized.tracks,
		items: materialized.items,
		assets: materialized.assets,
		shots: materialized.shots ?? [],
		compositionWidth: project.compositionWidth,
		compositionHeight: project.compositionHeight,
		fps: project.fps,
		fontInfos: collectFontInfoFromItems(Object.values(materialized.items)),
		...(project.propertyGraph ? {propertyGraph: project.propertyGraph} : {}),
		advanced:
			materialized.advanced ??
			createEmptyAdvancedProjectState(
				project.compositionWidth,
				project.compositionHeight,
				project.fps,
			),
	};
};
