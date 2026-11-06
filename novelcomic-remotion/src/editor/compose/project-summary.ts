import {EditorStarterAsset} from '../assets/assets';
import {LEGACY_SCHEMA_VERSION} from '../comic/limits';
import type {ProjectIssue, Shot} from '../comic/types';
import {validateProject} from '../comic/validate-project';
import {EditorStarterItem} from '../items/item-type';
import type {ImageMotion} from '../motion/types';
import {UndoableState} from '../state/types';
import {getTimelineEndFrame} from './build-state';

export {validateProject};
export type {ProjectIssue};

export type ProjectSummaryItem = {
	itemId: string;
	type: EditorStarterItem['type'];
	trackId: string | null;
	assetId: string | null;
	assetType: EditorStarterAsset['type'] | null;
	fromMs: number;
	durationMs: number;
	sourceStartMs: number | null;
	remoteUrl: string | null;
	decibelAdjustment: number | null;
	left: number;
	top: number;
	width: number;
	height: number;
	opacity: number;
	rotation: number;
	shotId: string | null;
	layerId: string | null;
	motion: ImageMotion | null;
	assetReady: boolean;
};

export type ProjectSummary = {
	compositionWidth: number;
	compositionHeight: number;
	fps: number;
	schemaVersion: number;
	durationInFrames: number;
	durationInSeconds: number;
	shots: Shot[];
	tracks: {
		trackId: string;
		muted: boolean;
		hidden: boolean;
		itemIds: string[];
		name: string | null;
		shotId: string | null;
		semantic: string | null;
	}[];
	items: ProjectSummaryItem[];
	errors: ProjectIssue[];
	warnings: ProjectIssue[];
};

const frameToMs = (frames: number, fps: number) =>
	Math.round((frames / fps) * 1000);

const getItemAssetId = (item: EditorStarterItem): string | null => {
	if ('assetId' in item) {
		return item.assetId;
	}

	return null;
};

const getSourceStartMs = (item: EditorStarterItem): number | null => {
	if (item.type === 'video') {
		return Math.round(item.videoStartFromInSeconds * 1000);
	}

	if (item.type === 'audio') {
		return Math.round(item.audioStartFromInSeconds * 1000);
	}

	if (item.type === 'gif') {
		return Math.round(item.gifStartFromInSeconds * 1000);
	}

	if (item.type === 'captions') {
		return Math.round(item.captionStartInSeconds * 1000);
	}

	return null;
};

const getDecibelAdjustment = (item: EditorStarterItem): number | null => {
	if (item.type === 'video' || item.type === 'audio') {
		return item.decibelAdjustment;
	}

	return null;
};

const assetReady = (asset: EditorStarterAsset | undefined): boolean => {
	if (!asset) {
		return false;
	}

	if (asset.type === 'caption') {
		return true;
	}

	return Boolean(asset.remoteUrl);
};

export const summarizeProject = (project: UndoableState): ProjectSummary => {
	const itemToTrackId = new Map<string, string>();
	for (const track of project.tracks) {
		for (const itemId of track.items) {
			itemToTrackId.set(itemId, track.id);
		}
	}

	const durationInFrames = getTimelineEndFrame(project);
	const issues = validateProject(project);

	return {
		compositionWidth: project.compositionWidth,
		compositionHeight: project.compositionHeight,
		fps: project.fps,
		schemaVersion: project.schemaVersion ?? LEGACY_SCHEMA_VERSION,
		durationInFrames,
		durationInSeconds: durationInFrames / project.fps,
		shots: project.shots ?? [],
		tracks: project.tracks.map((track) => ({
			trackId: track.id,
			muted: track.muted,
			hidden: track.hidden,
			itemIds: track.items,
			name: track.name ?? null,
			shotId: track.shotId ?? null,
			semantic: track.semantic ?? null,
		})),
		items: Object.values(project.items)
			.map((item): ProjectSummaryItem => {
				const assetId = getItemAssetId(item);
				const asset = assetId ? project.assets[assetId] : undefined;

				return {
					itemId: item.id,
					type: item.type,
					trackId: itemToTrackId.get(item.id) ?? null,
					assetId,
					assetType: asset?.type ?? null,
					fromMs: frameToMs(item.from, project.fps),
					durationMs: frameToMs(item.durationInFrames, project.fps),
					sourceStartMs: getSourceStartMs(item),
					remoteUrl: asset?.remoteUrl ?? null,
					decibelAdjustment: getDecibelAdjustment(item),
					left: item.left,
					top: item.top,
					width: item.width,
					height: item.height,
					opacity: item.opacity,
					rotation: 'rotation' in item ? item.rotation : 0,
					shotId: 'shotId' in item ? (item.shotId ?? null) : null,
					layerId: 'layerId' in item ? (item.layerId ?? null) : null,
					motion: item.type === 'image' ? (item.motion ?? null) : null,
					assetReady: assetReady(asset),
				};
			})
			.sort((a, b) => a.fromMs - b.fromMs),
		errors: issues.filter((entry) => entry.severity === 'error'),
		warnings: issues.filter((entry) => entry.severity === 'warning'),
	};
};
