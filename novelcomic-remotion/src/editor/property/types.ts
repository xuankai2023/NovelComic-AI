import type {EasingName, TransformLoop} from '../motion/types';

export const PROPERTY_GRAPH_VERSION = 1 as const;

export type PropertyOwnerKind = 'item' | 'shot' | 'advanced-layer';

export type PropertyOwner = {
	kind: PropertyOwnerKind;
	id: string;
};

export type NumericKeyframe = {
	frame: number;
	value: number;
	easing: EasingName;
	hold?: boolean;
	handleIn?: {x: number; y: number};
	handleOut?: {x: number; y: number};
};

export type NumericProperty = {
	baseValue: number;
	keyframes: NumericKeyframe[];
};

export type PropertySet = {
	owner: PropertyOwner;
	properties: Record<string, NumericProperty>;
	loop: TransformLoop;
	loopStartFrame?: number;
	loopEndFrame?: number;
	/** Advanced sets are evaluated by the graph but are intentionally not editable. */
	readOnly?: boolean;
};

export type PropertyMigrationWarning = {
	owner: PropertyOwner;
	field: string;
	message: string;
};

export type PropertyGraphV1 = {
	version: typeof PROPERTY_GRAPH_VERSION;
	sets: Record<string, PropertySet>;
	warnings?: PropertyMigrationWarning[];
};

export const propertySetId = (owner: PropertyOwner): string =>
	`${owner.kind}:${owner.id}`;

export const createEmptyPropertyGraph = (): PropertyGraphV1 => ({
	version: PROPERTY_GRAPH_VERSION,
	sets: {},
});
