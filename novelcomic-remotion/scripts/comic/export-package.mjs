#!/usr/bin/env node
/* eslint-disable no-undef */

import {
	buildExportFiles,
	commandBody,
	executeStage,
	isMainModule,
	parseCliArgs,
	requestJson,
} from './common.mjs';

const usage = () => {
	process.stdout.write(`
生成 manifest 和真实交付 ZIP

参数：
  --production-id <id>
  --production-dir <dir>
  --base-url <url>
  --allow-incomplete-package    有缺失文件时也生成包
`);
};

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'export-package',
		rawOptions,
		inputStage: 'render-batches',
		requiresProject: true,
		handler: async ({options, state, project, commandId, readStage}) => {
			const analysisStage = await readStage('analyze-page');
			const previewStage = await readStage('preview-review');
			const batchStage = await readStage('plan-batches');
			const renderStage = await readStage('render-batches');
			const analysis = analysisStage.metadata?.pageAnalysis;
			const batches = batchStage.metadata?.batches ?? [];
			const renderResults = renderStage.metadata?.renderResults ?? [];
			const files = buildExportFiles(project);
			if (analysis?.sourceUrl) {
				files.push({
					path: 'source/page.png',
					category: 'source',
					order: 0,
					url: analysis.sourceUrl,
				});
			}
			for (const [index, preview] of (
				previewStage.metadata?.previews ?? []
			).entries()) {
				const url = preview.url;
				if (!url) {
					continue;
				}
				files.push({
					path: `preview/${preview.shotId}-${preview.frame}.png`,
					category: 'preview',
					order: index,
					url,
				});
			}
			for (const result of renderResults) {
				const outputFile = result.outputFile ?? result.url;
				if (!outputFile) {
					continue;
				}
				const batch = batches.find((entry) => entry.batchId === result.batchId);
				files.push({
					path: `final-video/${result.batchId}.mp4`,
					category: 'final-video',
					order: batch?.batchIndex ?? 0,
					url: outputFile,
					...(result.checksum ? {checksum: result.checksum} : {}),
					...(result.outputSizeInBytes
						? {sizeBytes: result.outputSizeInBytes}
						: {}),
				});
			}
			const response = await requestJson({
				baseUrl: options.baseUrl,
				path: '/api/compose/project/export-package',
				productionId: state.productionId,
				commandId,
				requestId: commandId,
				body: commandBody(state, commandId, {
					projectId: state.projectId,
					project,
					batches,
					files,
				}),
			});
			const missingFiles = response.missingFiles ?? [];
			if (missingFiles.length > 0 && !options.allowIncompletePackage) {
				return {
					project,
					result: 'degraded',
					metadata: {
						...response,
						files,
						missingFiles,
					},
					diagnostics: missingFiles.map(
						(file) => `${file.path}: ${file.reason}`,
					),
					degradation: [
						{
							code: 'DELIVERY_PACKAGE_INCOMPLETE',
							message: '交付 ZIP 已生成，但仍有缺失文件',
							missingFiles,
						},
					],
					artifacts: [
						{
							id: `package:${state.productionId}`,
							kind: 'zip',
							status: 'completed',
							url: response.packageUrl,
							metadata: {missingFiles},
						},
					],
				};
			}
			return {
				project,
				metadata: {...response, files, missingFiles},
				artifacts: [
					{
						id: `package:${state.productionId}`,
						kind: 'zip',
						status: 'completed',
						url: response.packageUrl,
						metadata: {
							packageKey: response.packageKey,
							packageSizeBytes: response.packageSizeBytes,
							missingFiles,
						},
					},
				],
				...(missingFiles.length > 0
					? {
							result: 'degraded',
							degradation: [
								{
									code: 'DELIVERY_PACKAGE_INCOMPLETE',
									message: '交付 ZIP 包含缺失文件',
									missingFiles,
								},
							],
						}
					: {}),
			};
		},
	});

if (isMainModule(import.meta.url)) {
	try {
		const options = parseCliArgs(process.argv.slice(2), {
			booleanKeys: ['allowIncompletePackage'],
		});
		if (options.help) {
			usage();
		} else {
			await run(options);
		}
	} catch (error) {
		process.stderr.write(
			`导出交付包失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
