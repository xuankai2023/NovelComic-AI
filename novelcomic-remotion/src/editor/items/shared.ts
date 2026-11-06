export type BaseItem = {
	id: string;
	durationInFrames: number;
	from: number;
	top: number;
	left: number;
	width: number;
	height: number;
	opacity: number;
	isDraggingInTimeline: boolean;
};

export type CanHaveBorderRadius = BaseItem & {
	borderRadius: number;
};

export type CanHaveRotation = BaseItem & {
	rotation: number;
};

export type CanHaveCrop = {
	cropLeft: number;
	cropTop: number;
	cropRight: number;
	cropBottom: number;
};
