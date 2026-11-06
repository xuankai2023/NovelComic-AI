import {EditorStarterAsset} from '../assets/assets';
import type {Shot} from '../comic/types';
import type {AdvancedProjectState} from '../composition/types';
import {EditorStarterItem} from '../items/item-type';
import type {PropertyGraphV1} from '../property/types';
import {TrackType} from '../state/types';
import {VideoCodec} from '../utils/export-file-name';

export type RenderVideoPayload = {
	compositionHeight: number;
	compositionWidth: number;
	fps: number;
	tracks: TrackType[];
	items: Record<string, EditorStarterItem>;
	assets: Record<string, EditorStarterAsset>;
	codec?: VideoCodec;
	shots?: Shot[];
	advanced?: AdvancedProjectState;
	propertyGraph?: PropertyGraphV1;
	frameRange?: [startFrame: number, endFrameInclusive: number];
	enforceBatchDuration?: boolean;
	projectId?: string;
	inputSnapshotId?: string;
	inputContentHash?: string;
	preflightHash?: string;
	warningsConfirmed?: boolean;
};

export type RenderVideoResponse =
	| {
			type: 'success';
			bucketName: string;
			renderId: string;
			backend?: 'local' | 'lambda';
	  }
	| {
			type: 'error';
			error: string;
	  };

export type RenderCostInfo = {
	price: number;
	displayCost: string;
	currency: string;
	disclaimer: string;
	estimatedBillingDurationInMs: number;
};

export type GetProgressResponse =
	| {
			type: 'done';
			outputFile: string;
			outputSizeInBytes: number;
			outputName: string;
			checksum?: string;
			costs?: RenderCostInfo;
	  }
	| {
			type: 'in-progress';
			overallProgress: number;
			costs?: RenderCostInfo;
	  }
	| {
			type: 'error';
			error: string;
			code?: string;
			retryable?: boolean;
	  }
	| {
			type: 'canceled';
			outputFile?: string;
			outputSizeInBytes?: number;
			outputName?: string;
			checksum?: string;
	  };

export type GetProgressPayload = {
	bucketName: string;
	renderId: string;
	startedAt?: number;
};

export type CancelRenderPayload = {
	bucketName: string;
	renderId: string;
};

export type CancelRenderResponse =
	| {
			type: 'canceled';
			code?: undefined;
			outputFile?: string;
			outputSizeInBytes?: number;
			outputName?: string;
			checksum?: string;
	  }
	| {
			type: 'done';
			outputFile: string;
			outputSizeInBytes: number;
			outputName: string;
			checksum?: string;
	  }
	| {
			type: 'unsupported';
			code: 'CANCEL_UNSUPPORTED';
			message: string;
	  }
	| {
			type: 'error';
			code?: string;
			message: string;
			retryable: boolean;
	  };
