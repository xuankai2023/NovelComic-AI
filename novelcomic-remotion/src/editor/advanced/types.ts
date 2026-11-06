import type {LayerBounds} from '../comic/types';

/** Animation-workspace geometry types. Compositor documents use document/types.ts. */
export type LayerGroup = {id: string; name: string; trackIds: string[]; parentGroupId?: string; visible: boolean; locked: boolean; collapsed: boolean};
export type AdjustmentEffects = {brightness: number; contrast: number; saturation: number; hue: number; blur: number};
export type AdjustmentLayer = {id: string; name: string; targetTrackIds: string[]; effects: AdjustmentEffects; visible: boolean; opacity: number};
export type PixelSelectionMode = 'magic-wand' | 'color-range';
export type PixelSelectionOptions = {tolerance: number; contiguous?: boolean; antialias?: boolean};
export type BezierHandle = {x: number; y: number};
export type BezierAnchor = {x: number; y: number; inHandle?: BezierHandle; outHandle?: BezierHandle};
export type PenPath = {id: string; name: string; closed: boolean; anchors: BezierAnchor[]; bounds?: LayerBounds};
export type BoneKeyframe = {frame: number; x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number};
export type Bone = {id: string; name: string; parentId?: string; x: number; y: number; length: number; rotation: number; scaleX: number; scaleY: number; keyframes?: BoneKeyframe[]};
export type BoneRig = {bones: Bone[]; rootBoneId: string};
export type MeshPoint = {x: number; y: number};
export type MeshKeyframe = {frame: number; points: MeshPoint[]};
export type MeshGrid = {columns: number; rows: number; points: MeshPoint[]; keyframes?: MeshKeyframe[]};
