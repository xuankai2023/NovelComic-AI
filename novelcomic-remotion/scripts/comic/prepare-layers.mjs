#!/usr/bin/env node
/* eslint-disable no-undef */

import {
	assertHttpsUrl,
	commandBody,
	executeStage,
	isMainModule,
	normalizedDegradation,
	parseCliArgs,
	poll,
	readJson,
	requestJson,
} from './common.mjs';

const usage = () => {
	process.stdout.write(`
请求自动拆层、轮询 LayerPackage，并执行 Clean Plate 补图

参数：
  --production-id <id>
  --production-dir <dir>
  --base-url <url>
  --layer-file <file>            已有 LayerPackage（对象、数组或 packages 映射）
  --clean-plate-file <file>      Clean Plate 请求清单
  --segmentation-timeout <ms>   分割轮询超时
  --poll-interval <ms>           轮询间隔
  --allow-layer-fallback         拆层失败时继续使用 L0
`);
};

const asPackages = (value) => {
	const raw = value?.packages ?? value?.layerPackages ?? value;
	if (Array.isArray(raw)) {
		return raw;
	}
	if (raw && typeof raw === 'object' && Array.isArray(raw.layers)) {
		return [raw];
	}
	if (raw && typeof raw === 'object') {
		return Object.values(raw);
	}
	return [];
};

const panelForShot = (analysis, shotStage, shotId) => {
	const shot = (shotStage.metadata?.shots ?? []).find(
		(entry) => entry.shotId === shotId,
	);
	return analysis.panels.find((panel) => panel.panelId === shot?.panelId);
};

const cleanPlateRequestsFor = (value, shotId) => {
	const raw = value?.requests ?? value?.cleanPlateRequests ?? value;
	if (Array.isArray(raw)) {
		return raw.filter((entry) => entry.shotId === shotId || !entry.shotId);
	}
	if (raw && typeof raw === 'object') {
		if (raw.sourceAssetId && raw.maskAssetId) {
			return raw.shotId && raw.shotId !== shotId ? [] : [raw];
		}
		return Array.isArray(raw[shotId]) ? raw[shotId] : [];
	}
	return [];
};

const diagnosticsForPackage = (layerPackage, options) => {
	const diagnostics = layerPackage.diagnostics ?? {};
	const failures = [];
	if (diagnostics.requiresFallback) {
		failures.push('provider requested fallback');
	}
	if (
		options.maxAlphaHoleRatio !== undefined &&
		Number(diagnostics.alphaHoleRatio) > Number(options.maxAlphaHoleRatio)
	) {
		failures.push(`alphaHoleRatio>${options.maxAlphaHoleRatio}`);
	}
	if (
		options.maxEdgeArtifactScore !== undefined &&
		Number(diagnostics.edgeArtifactScore) > Number(options.maxEdgeArtifactScore)
	) {
		failures.push(`edgeArtifactScore>${options.maxEdgeArtifactScore}`);
	}
	if (
		options.minRecompositionScore !== undefined &&
		Number(diagnostics.recompositionScore) <
			Number(options.minRecompositionScore)
	) {
		failures.push(`recompositionScore<${options.minRecompositionScore}`);
	}
	return failures;
};

const addCleanPlateLayer = (layerPackage, result) => {
	const asset = result.cleanPlateAsset;
	const canvas = layerPackage.canvas;
	return {
		...layerPackage,
		layers: [
			...layerPackage.layers.filter((layer) => layer.layerId !== 'clean-plate'),
			{
				layerId: 'clean-plate',
				name: 'Clean Plate',
				semantic: 'background',
				imageUrl: asset.remoteUrl,
				isCleanPlate: true,
				opacity: 1,
				zIndex: -1000,
				visible: true,
				bounds: {
					x: 0,
					y: 0,
					width: canvas.width,
					height: canvas.height,
				},
				anchor: {x: 0.5, y: 0.5},
				confidence: 1,
				motionPolicy: 'static',
			},
		],
		diagnostics: {
			...layerPackage.diagnostics,
			...(result.diagnostics
				? {
						recompositionScore: result.diagnostics.recompositionScore,
						alphaHoleRatio: result.diagnostics.alphaHoleRatio,
						edgeArtifactScore: result.diagnostics.edgeArtifactScore,
						warnings: [
							...(layerPackage.diagnostics?.warnings ?? []),
							...(result.diagnostics.warnings ?? []),
						],
					}
				: {}),
			requiresFallback: false,
		},
	};
};

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'prepare-layers',
		rawOptions,
		inputStage: 'add-voice',
		requiresProject: true,
		handler: async ({options, state, project, commandId, readStage}) => {
			const analysisStage = await readStage('analyze-page');
			const analysis = analysisStage.metadata?.pageAnalysis;
			const shotStage = await readStage('create-shots');
			const externalPackages = options.layerFile
				? asPackages(await readJson(options.layerFile))
				: [];
			const externalByShot = new Map(
				externalPackages.map((layerPackage) => [
					layerPackage.shotId,
					layerPackage,
				]),
			);
			const cleanPlateValue = options.cleanPlateFile
				? await readJson(options.cleanPlateFile)
				: null;
			const packages = [];
			const diagnostics = [];
			const degradation = [];
			for (const shot of project.shots ?? []) {
				const panel = panelForShot(analysis, shotStage, shot.id);
				if (!panel) {
					degradation.push(
						normalizedDegradation(
							'NO_PANEL_FOR_SHOT',
							`Shot ${shot.id} 没有对应分格，跳过自动拆层`,
							{shotId: shot.id},
						),
					);
					continue;
				}
				let layerPackage = externalByShot.get(shot.id);
				try {
					if (!layerPackage) {
						const requestId = `${commandId}:${shot.id}:segment`;
						const requested = await requestJson({
							baseUrl: options.baseUrl,
							path: '/api/compose/layers/request-segmentation',
							productionId: state.productionId,
							commandId: requestId,
							requestId,
							body: commandBody(state, requestId, {
								projectId: state.projectId,
								shotId: shot.id,
								sourceUrl: assertHttpsUrl(
									panel.cropUrl ?? panel.imageUrl ?? analysis.sourceUrl,
									`Shot ${shot.id} sourceUrl`,
								),
								canvas: {
									width: options.width,
									height: options.height,
								},
								semanticHints: [
									'background',
									'body',
									'head',
									'hair',
									'eye-open',
									'eye-closed',
									'mouth-closed',
									'mouth-half',
									'mouth-open',
								],
							}),
						});
						const task = requested.task ?? requested;
						const status = await poll(
							() =>
								requestJson({
									baseUrl: options.baseUrl,
									path: '/api/compose/layers/segmentation-status',
									productionId: state.productionId,
									commandId: requestId,
									requestId,
									body: {
										clientRequestId: requestId,
										jobId: task.jobId,
									},
								}),
							{
								timeoutMs:
									Number(options.segmentationTimeout) || options.pollTimeoutMs,
								intervalMs: options.pollIntervalMs,
								label: `Shot ${shot.id} 拆层`,
							},
						);
						if (status.status === 'failed') {
							throw new Error(status.error ?? 'segmentation failed');
						}
						layerPackage = status.layerPackage;
					}
					const qualityFailures = diagnosticsForPackage(layerPackage, options);
					if (qualityFailures.length > 0) {
						throw new Error(
							`LayerPackage 质量门禁失败：${qualityFailures.join(', ')}`,
						);
					}

					const requests = cleanPlateRequestsFor(
						cleanPlateValue ??
							layerPackage.cleanPlateRequests ??
							layerPackage.cleanPlateRequest ??
							[],
						shot.id,
					);
					for (const [index, cleanRequest] of requests.entries()) {
						const requestId = `${commandId}:${shot.id}:inpaint:${index}`;
						const response = await requestJson({
							baseUrl: options.baseUrl,
							path: '/api/compose/layers/inpaint',
							productionId: state.productionId,
							commandId: requestId,
							requestId,
							body: commandBody(state, requestId, {
								projectId: state.projectId,
								shotId: shot.id,
								sourceAssetId: cleanRequest.sourceAssetId,
								maskAssetId: cleanRequest.maskAssetId,
								sourceUrl: assertHttpsUrl(
									cleanRequest.sourceUrl ?? panel.cropUrl ?? analysis.sourceUrl,
									'Clean Plate sourceUrl',
								),
								maskUrl: assertHttpsUrl(
									cleanRequest.maskUrl,
									'Clean Plate maskUrl',
								),
								canvas: cleanRequest.canvas ?? {
									width: options.width,
									height: options.height,
								},
								mode: cleanRequest.mode ?? 'opencv-inpaint',
								version: Number(cleanRequest.version ?? 1),
								...(cleanRequest.fillColor
									? {fillColor: cleanRequest.fillColor}
									: {}),
								...(cleanRequest.cloneSource
									? {cloneSource: cleanRequest.cloneSource}
									: {}),
							}),
						});
						layerPackage = addCleanPlateLayer(layerPackage, response);
					}
					packages.push(layerPackage);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					diagnostics.push(`Shot ${shot.id}: ${message}`);
					degradation.push(
						normalizedDegradation(
							'LAYER_FALLBACK_TO_L0',
							`Shot ${shot.id} 拆层或 Clean Plate 失败，保留 L0`,
							{shotId: shot.id, reason: message},
						),
					);
					if (!options.allowLayerFallback) {
						throw error;
					}
				}
			}
			return {
				project,
				result: degradation.length ? 'degraded' : 'completed',
				metadata: {
					layerPackages: packages,
					readyShotIds: packages.map((layerPackage) => layerPackage.shotId),
				},
				artifacts: packages.map((layerPackage) => ({
					id: `layer-package:${layerPackage.shotId}`,
					kind: 'layer-package',
					status: 'completed',
					metadata: {
						layerCount: layerPackage.layers.length,
						diagnostics: layerPackage.diagnostics,
					},
				})),
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
			`准备拆层失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
