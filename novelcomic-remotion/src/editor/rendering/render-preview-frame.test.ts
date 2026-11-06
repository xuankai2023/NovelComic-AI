import {describe, expect, it} from 'vitest';
import {ComicEditorError} from '../comic/errors';
import {upsertShot} from '../comic/upsert-shot';
import {createComicProject} from '../compose/build-state';
import {comicProjectV2} from '../motion/fixtures/comic-project-v2';
import {renderPreviewFrame} from './render-preview-frame';

describe('renderPreviewFrame', () => {
	it('submits the absolute frame through official composition props', async () => {
		const project = upsertShot(createComicProject(), {
			shotId: 'shot-1',
			durationInFrames: 30,
		});
		const before = structuredClone(project);
		let seen:
			| {
					frame: number;
					width?: number;
					format: string;
					shots: unknown;
					compositionWidth: number;
			  }
			| undefined;

		const preview = await renderPreviewFrame({
			project,
			frame: 10,
			width: 540,
			format: 'jpeg',
			submit: async (job) => {
				seen = {
					frame: job.frame,
					width: job.width,
					format: job.format,
					shots: job.props.shots,
					compositionWidth: job.props.compositionWidth,
				};
				return {
					url: 'https://cdn.example.com/frame.jpeg',
					taskId: 'task-1',
				};
			},
		});

		expect(seen).toEqual({
			frame: 10,
			width: 540,
			format: 'jpeg',
			shots: project.shots,
			compositionWidth: 1080,
		});
		expect(preview).toEqual({
			url: 'https://cdn.example.com/frame.jpeg',
			taskId: 'task-1',
		});
		expect(project).toEqual(before);
	});

	it('accepts a task id when the still worker has not finished', async () => {
		const project = upsertShot(createComicProject(), {
			shotId: 'shot-1',
			durationInFrames: 12,
		});

		await expect(
			renderPreviewFrame({
				project,
				frame: 0,
				submit: async () => {
					return {taskId: 'still-task'};
				},
			}),
		).resolves.toEqual({taskId: 'still-task'});
	});

	it('rejects a frame outside the project before submission', async () => {
		const project = upsertShot(createComicProject(), {
			shotId: 'shot-1',
			durationInFrames: 30,
		});
		let submitted = false;

		await expect(
			renderPreviewFrame({
				project,
				frame: 30,
				submit: async () => {
					submitted = true;
					return {taskId: 'should-not-run'};
				},
			}),
		).rejects.toBeInstanceOf(ComicEditorError);
		expect(submitted).toBe(false);
	});

	it('rejects invalid Transform data before still submission', async () => {
		const project = structuredClone(comicProjectV2);
		const item = project.items['item-shot-a-character'];
		if (item.type === 'image') item.motion = {transform: {keyframes: [{frame: 0, scaleX: 0}]}};
		let submitted = false;
		await expect(
			renderPreviewFrame({
				project,
				frame: 1,
				submit: async () => {
					submitted = true;
					return {taskId: 'should-not-run'};
				},
			}),
		).rejects.toThrow(/Scale|invalid|Transform/i);
		expect(submitted).toBe(false);
	});

	it('turns a worker failure into a retryable dependency error without the signed query', async () => {
		const project = upsertShot(createComicProject(), {
			shotId: 'shot-1',
			durationInFrames: 8,
		});

		await expect(
			renderPreviewFrame({
				project,
				frame: 1,
				submit: async () => {
					throw new Error(
						'failed https://cdn.example.com/still.png?X-Amz-Signature=secret-token',
					);
				},
			}),
		).rejects.toMatchObject({
			code: 'DEPENDENCY_UNAVAILABLE',
			retryable: true,
			status: 503,
			message: 'failed https://cdn.example.com/still.png',
		});
	});
});
