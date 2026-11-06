import {describe, expect, it} from 'vitest';
import {POST as padRoute} from '../../../app/api/compose/project/pad/route';
import {createComicProject} from '../compose/build-state';
import {upsertShot} from './upsert-shot';

const post = async (body: unknown) => {
	const response = await padRoute(
		new Request('https://editor.local/api/compose/project/pad', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify(body),
		}),
	);
	const json = (await response.json()) as {
		type: string;
		project?: {
			shots?: Array<{id: string; durationInFrames: number}>;
			items: Record<string, {id: string; durationInFrames: number}>;
		};
		code?: string;
	};
	return {response, json};
};

describe('POST /api/compose/project/pad', () => {
	it('extends a short project, leaves a long project unchanged, and replays the same result', async () => {
		const short = upsertShot(createComicProject({fps: 30}), {
			shotId: 'shot-1',
			durationInFrames: 60,
		});
		const first = await post({
			project: short,
			clientRequestId: 'pad-1',
			expectedRevision: 0,
			minimumDurationInFrames: 150,
		});
		expect(first.response.status).toBe(200);
		expect(first.json.project?.shots?.[0]).toMatchObject({
			id: 'shot-1',
			durationInFrames: 150,
		});

		const replay = await post({
			project: short,
			clientRequestId: 'pad-1',
			expectedRevision: 0,
			minimumDurationInFrames: 150,
		});
		expect(replay.json.project).toEqual(first.json.project);

		const again = await post({
			project: first.json.project,
			minimumDurationInFrames: 150,
		});
		expect(again.json.project).toEqual(first.json.project);

		const long = upsertShot(createComicProject({fps: 30}), {
			shotId: 'shot-1',
			durationInFrames: 180,
		});
		const unchanged = await post({project: long});
		expect(unchanged.response.status).toBe(200);
		expect(unchanged.json.project?.shots).toEqual(long.shots);
		expect(unchanged.json.project?.items).toEqual(long.items);
	});

	it('returns the domain error when the project has no shots', async () => {
		const failed = await post({project: createComicProject()});
		expect(failed.response.status).toBe(422);
		expect(failed.json.code).toBe('DOMAIN_INVARIANT');
	});
});
