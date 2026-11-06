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
为每个 Shot 添加 L0 原图/分格面板

参数：
  --production-id <id>
  --production-dir <dir>
  --base-url <url>
  --panel-fit-policy <policy>    默认 blurred-background-contain
`);
};

const analysisFrom = (stage) =>
	stage?.metadata?.pageAnalysis ?? stage?.analysis;

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'add-source-panels',
		rawOptions,
		inputStage: 'create-shots',
		requiresProject: true,
		handler: async ({options, state, project, commandId, readStage}) => {
			const analysis = analysisFrom(await readStage('analyze-page'));
			const shotStage = await readStage('create-shots');
			const shots = shotStage.metadata?.shots ?? [];
			const shotByPanel = new Map(shots.map((shot) => [shot.panelId, shot]));
			const images = analysis.panels.map((panel) => {
				const shot = shotByPanel.get(panel.panelId);
				if (!shot) {
					throw new Error(`找不到分格 ${panel.panelId} 对应的 Shot`);
				}
				return {
					shotId: shot.shotId,
					url: panel.cropUrl ?? panel.imageUrl ?? analysis.sourceUrl,
					width: Math.max(1, Math.round(panel.width ?? analysis.pageWidth)),
					height: Math.max(1, Math.round(panel.height ?? analysis.pageHeight)),
					durationInFrames: shot.durationInFrames,
				};
			});
			const response = await requestJson({
				baseUrl: options.baseUrl,
				path: '/api/compose/image/sequence',
				productionId: state.productionId,
				commandId,
				requestId: commandId,
				body: commandBody(state, commandId, {
					project,
					images,
					panelFitPolicy:
						options.panelFitPolicy ?? 'blurred-background-contain',
					fitAlgorithmVersion: 'contain-blur-v1',
					blurRadiusPx: 28,
					dimOpacity: 0.45,
					compositionWidth: options.width,
					compositionHeight: options.height,
				}),
			});
			return {
				project: response.project,
				metadata: {images, panelCount: images.length},
				artifacts: [
					{
						id: `source-panels:${state.productionId}`,
						kind: 'panel',
						status: 'completed',
						metadata: {panelCount: images.length},
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
			`添加原图面板失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
