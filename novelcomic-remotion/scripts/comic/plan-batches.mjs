#!/usr/bin/env node
/* eslint-disable no-undef */

import {
	commandBody,
	executeStage,
	isMainModule,
	parseCliArgs,
	requestJson,
} from './common.mjs';

const usage = () => {
	process.stdout.write(`
规划输出批次

参数：
  --production-id <id>
  --production-dir <dir>
  --base-url <url>
`);
};

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'plan-batches',
		rawOptions,
		inputStage: 'preview-review',
		requiresProject: true,
		handler: async ({options, state, project, commandId}) => {
			const response = await requestJson({
				baseUrl: options.baseUrl,
				path: '/api/compose/project/plan-batches',
				productionId: state.productionId,
				commandId,
				requestId: commandId,
				body: commandBody(state, commandId, {project}),
			});
			return {
				project,
				metadata: {batches: response.batches ?? []},
				artifacts: [
					{
						id: `batches:${state.productionId}`,
						kind: 'project',
						status: 'completed',
						metadata: {batchCount: (response.batches ?? []).length},
					},
				],
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
			`批次规划失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
