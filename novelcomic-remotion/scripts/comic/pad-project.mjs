#!/usr/bin/env node
/* eslint-disable no-undef */

import {
	commandBody,
	executeStage,
	isMainModule,
	parseCliArgs,
	projectDuration,
	requestJson,
} from './common.mjs';

const usage = () => {
	process.stdout.write(`
将过短工程补齐到批次最短时长

参数：
  --production-id <id>
  --production-dir <dir>
  --base-url <url>
  --minimum-seconds <seconds>   默认 5
`);
};

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'pad-project',
		rawOptions,
		inputStage: 'apply-sprite-motion',
		requiresProject: true,
		handler: async ({options, state, project, commandId}) => {
			const minimumSeconds = Number(options.minimumSeconds ?? 5);
			const minimumDurationInFrames = Math.max(
				1,
				Math.round(minimumSeconds * options.fps),
			);
			const response = await requestJson({
				baseUrl: options.baseUrl,
				path: '/api/compose/project/pad',
				productionId: state.productionId,
				commandId,
				requestId: commandId,
				body: commandBody(state, commandId, {
					project,
					minimumDurationInFrames,
				}),
			});
			const padded =
				projectDuration(response.project) > projectDuration(project);
			return {
				project: response.project,
				metadata: {
					minimumDurationInFrames,
					wasPadded: padded,
					beforeDurationInFrames: projectDuration(project),
					afterDurationInFrames: projectDuration(response.project),
				},
			};
		},
	});

if (isMainModule(import.meta.url)) {
	try {
		const options = parseCliArgs(process.argv.slice(2));
		if (options.help) {
			usage();
		} else {
			await run(options);
		}
	} catch (error) {
		process.stderr.write(
			`补齐时长失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
