import {describe, expect, it} from 'vitest';
import {
	RenderJobOutputError,
	RenderJobTransitionError,
	createRenderJob,
	transitionRenderJob,
} from './render-job-machine';
import type {RenderJob} from './render-job-types';

const makeJob = (): RenderJob =>
	createRenderJob({
		jobId: 'job-1',
		projectId: 'project-1',
		inputSnapshotId: 'snapshot-1',
		inputContentHash: 'hash-1',
		inputRevision: 4,
		kind: 'full-video',
		backend: 'local',
		createdAt: '2026-10-06T00:00:00.000Z',
	});

const submittedJob = () => {
	let job = makeJob();
	job = transitionRenderJob(job, {type: 'validate'});
	job = transitionRenderJob(job, {
		type: 'submit',
		handle: {renderId: 'render-1', bucketName: 'local'},
	});
	return transitionRenderJob(job, {type: 'progress', progress: 0.25});
};

describe('RenderJob state machine', () => {
	it('accepts the normal lifecycle and keeps the input binding immutable', () => {
		const running = submittedJob();
		const succeeded = transitionRenderJob(running, {
			type: 'succeed',
			output: {
				outputFile: 'https://cdn.example.com/render.mp4',
				outputName: 'render.mp4',
				outputSizeInBytes: 123,
				checksum: 'abc123',
			},
		});

		expect(succeeded.status).toBe('succeeded');
		expect(succeeded.progress).toBe(1);
		expect(succeeded.inputSnapshotId).toBe('snapshot-1');
		expect(succeeded.inputContentHash).toBe('hash-1');
	});

	it('rejects illegal transitions and invalid outputs', () => {
		expect(() =>
			transitionRenderJob(makeJob(), {
				type: 'succeed',
				output: {
					outputFile: 'https://cdn.example.com/render.mp4',
					outputSizeInBytes: 1,
				},
			}),
		).toThrow(RenderJobTransitionError);
		expect(() =>
			transitionRenderJob(submittedJob(), {
				type: 'succeed',
				output: {
					outputFile: 'http://insecure.example.com/render.mp4',
					outputSizeInBytes: 1,
				},
			}),
		).toThrow(RenderJobOutputError);
	});

	it('lets a real backend completion win a cancel race', () => {
		const requested = transitionRenderJob(submittedJob(), {
			type: 'request-cancel',
		});
		expect(
			transitionRenderJob(requested, {type: 'progress', progress: 0.5}).status,
		).toBe('cancel-requested');
		const succeeded = transitionRenderJob(requested, {
			type: 'succeed',
			output: {
				outputFile: 'https://cdn.example.com/render.mp4',
				outputSizeInBytes: 3,
			},
		});
		expect(succeeded.status).toBe('succeeded');
		expect(() => transitionRenderJob(succeeded, {type: 'cancel'})).toThrow(
			RenderJobTransitionError,
		);
	});

	it('allows at most three attempts', () => {
		let job = submittedJob();
		for (let attempt = 1; attempt < 3; attempt += 1) {
			job = transitionRenderJob(job, {
				type: 'fail',
				error: {code: 'TEMP', message: 'temporary', retryable: true},
			});
			job = transitionRenderJob(job, {type: 'retry'});
			job = transitionRenderJob(job, {type: 'validate'});
			job = transitionRenderJob(job, {
				type: 'submit',
				handle: {renderId: `render-${attempt + 1}`, bucketName: 'local'},
			});
		}
		job = transitionRenderJob(job, {
			type: 'fail',
			error: {code: 'TEMP', message: 'temporary', retryable: true},
		});
		expect(job.attempt).toBe(3);
		expect(() => transitionRenderJob(job, {type: 'retry'})).toThrow(
			/retry limit/,
		);
	});
});
