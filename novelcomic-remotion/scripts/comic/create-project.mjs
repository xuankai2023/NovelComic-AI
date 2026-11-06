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
创建动态漫画工程

用法：
  node scripts/comic/create-project.mjs --production-id <id>

参数：
  --production-id <id>           生产/工程 ID
  --production-dir <dir>         产物目录
  --base-url <url>               Remotion API 地址
  --width <number>               画布宽度，默认 1080
  --height <number>              画布高度，默认 1920
  --fps <number>                 帧率，默认 30
`);
};

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'create-project',
		rawOptions,
		handler: async ({options, state, commandId}) => {
			const response = await requestJson({
				baseUrl: options.baseUrl,
				path: '/api/compose/project/create',
				productionId: state.productionId,
				commandId,
				requestId: commandId,
				body: commandBody(state, commandId, {
					compositionWidth: options.width,
					compositionHeight: options.height,
					fps: options.fps,
				}),
			});
			if (!response.project) {
				throw new Error('project/create 没有返回 project');
			}
			return {
				project: response.project,
				artifacts: [
					{
						id: `project:${state.projectId}:revision-0`,
						kind: 'project',
						status: 'completed',
						metadata: {revision: 0},
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
			`创建工程失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
