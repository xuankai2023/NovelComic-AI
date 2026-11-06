import {renderBackend} from '../utils/server-env';
import {getRenderBackendAdapter} from './render-backend';
import type {RenderVideoPayload} from './types';
import {validateRenderPayload} from './validate-render-payload';

export type RenderSubmission = {
	renderId: string;
	bucketName: string;
	backend: 'local' | 'lambda';
};

export const submitRender = async (
	payload: RenderVideoPayload,
): Promise<RenderSubmission> => {
	validateRenderPayload(payload);
	const backend = renderBackend();
	const handle = await getRenderBackendAdapter(backend).submit(payload);
	return {...handle, backend};
};
