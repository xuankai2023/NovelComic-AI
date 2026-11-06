#!/usr/bin/env node
/* eslint-disable no-undef */

import {
	commandBody,
	executeStage,
	isMainModule,
	normalizedDegradation,
	parseCliArgs,
	requestJson,
} from './common.mjs';

const usage = () => {
	process.stdout.write(`
导入通过质量门禁的 LayerPackage

参数：
  --production-id <id>
  --production-dir <dir>
  --base-url <url>
  --allow-layer-fallback         单个 Shot 导入失败时保留 L0 并继续
`);
};

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'import-layers',
		rawOptions,
		inputStage: 'prepare-layers',
		requiresProject: true,
		handler: async ({options, state, project, commandId, input}) => {
			const packages = input?.metadata?.layerPackages ?? [];
			let next = project;
			const importedShotIds = [];
			const diagnostics = [];
			const degradation = [...(input?.degradation ?? [])];
			for (const layerPackage of packages) {
				const requestId = `${commandId}:${layerPackage.shotId}`;
				try {
					const response = await requestJson({
						baseUrl: options.baseUrl,
						path: '/api/compose/layers/import',
						productionId: state.productionId,
						commandId: requestId,
						requestId,
						body: commandBody(state, requestId, {
							project: next,
							layerPackage,
						}),
					});
					next = response.project;
					importedShotIds.push(layerPackage.shotId);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					diagnostics.push(`Shot ${layerPackage.shotId}: ${message}`);
					degradation.push(
						normalizedDegradation(
							'LAYER_IMPORT_FALLBACK_TO_L0',
							`Shot ${layerPackage.shotId} 导入失败，保留 L0`,
							{shotId: layerPackage.shotId, reason: message},
						),
					);
					if (!options.allowLayerFallback) {
						throw error;
					}
				}
			}
			return {
				project: next,
				result: degradation.length ? 'degraded' : 'completed',
				metadata: {
					importedShotIds,
					attemptedShotIds: packages.map((layerPackage) => layerPackage.shotId),
				},
				artifacts: [
					{
						id: `imported-layers:${state.productionId}`,
						kind: 'layer-package',
						status: importedShotIds.length > 0 ? 'completed' : 'failed',
						metadata: {importedShotIds},
					},
				],
				diagnostics,
				degradation,
			};
		},
	});

if (isMainModule(import.meta.url)) {
	try {
		const options = parseCliArgs(process.argv.slice(2), {
			booleanKeys: ['allowLayerFallback'],
		});
		if (options.help) {
			usage();
		} else {
			await run(options);
		}
	} catch (error) {
		process.stderr.write(
			`导入拆层失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
