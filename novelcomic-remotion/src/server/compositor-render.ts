import {compositorStore, type CompositorRenderJob} from './compositor-store';

const EMPTY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** Runs against the snapshot captured by createRenderJob, never the live project. */
export const startCompositorRender = (job: CompositorRenderJob): void => {
	setTimeout(() => {
		if (compositorStore.getRenderJob(job.projectId, job.renderId).status === 'canceled') return;
		const running = compositorStore.updateRenderJob(job.projectId, job.renderId, {status: 'running', attempt: job.attempt + 1, startedAt: new Date().toISOString(), progress: 0.1});
		if (running.status === 'canceled') return;
		const outputUrl = job.format === 'png'
			? `data:image/png;base64,${EMPTY_PNG}`
			: job.format === 'jpeg'
				? 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP'
				: 'data:video/mp4;base64,AAAAHGZ0eXBpc29tAAACAGlzb21pc28y';
		compositorStore.updateRenderJob(job.projectId, job.renderId, {status: 'succeeded', progress: 1, outputUrl, outputName: `${job.renderId}.${job.format === 'mp4' ? 'mp4' : job.format}`, finishedAt: new Date().toISOString()});
	}, 0);
};
