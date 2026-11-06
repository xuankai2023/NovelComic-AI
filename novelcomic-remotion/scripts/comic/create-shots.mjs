#!/usr/bin/env node
/* eslint-disable no-undef */

import {
	commandBody,
	executeStage,
	getShot,
	isMainModule,
	numberValue,
	parseCliArgs,
	requestJson,
} from './common.mjs';

const usage = () => {
	process.stdout.write(`
根据 PageAnalysis 创建多个 Shot

参数：
  --production-id <id>
  --production-dir <dir>
  --base-url <url>
  --duration <seconds>           每个 Shot 默认时长，默认 8
  --crossfade <frames>           Shot 之间使用 crossfade
`);
};

const analysisFrom = (stage) =>
	stage?.metadata?.pageAnalysis ?? stage?.analysis;

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'create-shots',
		rawOptions,
		inputStage: 'create-project',
		requiresProject: true,
		handler: async ({options, state, project, commandId, readStage}) => {
			const analysisStage = await readStage('analyze-page');
			const analysis = analysisFrom(analysisStage);
			if (!analysis?.panels?.length) {
				throw new Error('analyze-page 没有返回 panels');
			}
			let next = project;
			let from = 0;
			const shots = [];
			for (const [index, panel] of analysis.panels.entries()) {
				const shotId =
					panel.shotId ?? `shot-${String(index + 1).padStart(3, '0')}`;
				const durationInFrames =
					Number(panel.durationInFrames) ||
					Math.max(
						1,
						Math.round(
							(Number(panel.durationSeconds) || options.durationSeconds) *
								options.fps,
						),
					);
				const response = await requestJson({
					baseUrl: options.baseUrl,
					path: '/api/compose/shot/create',
					productionId: state.productionId,
					commandId: `${commandId}:${shotId}`,
					requestId: `${commandId}:${shotId}`,
					body: commandBody(state, `${commandId}:${shotId}`, {
						project: next,
						shotId,
						name: panel.name ?? `漫画分格 ${index + 1}`,
						from,
						durationInFrames,
						transitionOut:
							options.crossfade !== undefined &&
							index < analysis.panels.length - 1
								? {
										type: 'crossfade',
										durationInFrames: numberValue(
											options.crossfade,
											'--crossfade',
											{integer: true, min: 1},
										),
									}
								: {type: 'cut'},
					}),
				});
				next = response.project;
				const shot = getShot(next, shotId);
				shots.push({
					shotId,
					panelId: panel.panelId,
					from,
					durationInFrames,
					...(shot ? {shot} : {}),
				});
				from += durationInFrames;
			}
			return {
				project: next,
				metadata: {shots, pageId: analysis.pageId},
				artifacts: [
					{
						id: `shots:${state.productionId}`,
						kind: 'project',
						status: 'completed',
						metadata: {shotCount: shots.length},
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
			`创建 Shot 失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
