#!/usr/bin/env node
/* eslint-disable no-undef */

import {
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
提交批次渲染，并可选轮询外部渲染状态

参数：
  --production-id <id>
  --production-dir <dir>
  --base-url <url>
  --render-status-url <url>     外部状态查询服务
  --render-results <file>       已有渲染结果 JSON
  --poll-interval <ms>
  --poll-timeout <ms>
  --allow-render-pending        没有最终视频 URL 时保留 submitted 状态
`);
};

const normalizeRenderResults = (value) => {
	const raw = value?.results ?? value ?? [];
	return Array.isArray(raw) ? raw : Object.values(raw);
};

const pollRender = async (options, state, commandId, result) => {
	if (!options.renderStatusUrl) {
		return result;
	}
	return poll(
		() =>
			requestJson({
				path: options.renderStatusUrl,
				baseUrl: options.baseUrl,
				productionId: state.productionId,
				commandId,
				requestId: commandId,
				body: {
					productionId: state.productionId,
					batchId: result.batchId,
					renderId: result.renderId,
					bucketName: result.bucketName,
				},
			}),
		{
			timeoutMs: options.pollTimeoutMs,
			intervalMs: options.pollIntervalMs,
			label: `批次 ${result.batchId} 渲染`,
		},
	);
};

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'render-batches',
		rawOptions,
		inputStage: 'plan-batches',
		requiresProject: true,
		handler: async ({options, state, project, commandId, readStage}) => {
			const batchStage = await readStage('plan-batches');
			const batches = batchStage.metadata?.batches ?? [];
			const response = await requestJson({
				baseUrl: options.baseUrl,
				path: '/api/compose/project/render-batches',
				productionId: state.productionId,
				commandId,
				requestId: commandId,
				body: commandBody(state, commandId, {project}),
			});
			const submitted = response.results ?? [];
			const saved = options.renderResults
				? normalizeRenderResults(await readJson(options.renderResults))
				: [];
			const savedByBatch = new Map(
				saved.map((result) => [result.batchId, result]),
			);
			const finalResults = [];
			const diagnostics = [];
			const degradation = [];
			for (const result of submitted) {
				if (result.ok === false) {
					finalResults.push(result);
					degradation.push(
						normalizedDegradation(
							'BATCH_RENDER_FAILED',
							`批次 ${result.batchId} 渲染提交失败`,
							{batchId: result.batchId, reason: result.error?.message},
						),
					);
					continue;
				}
				try {
					const savedResult = savedByBatch.get(result.batchId);
					const polled =
						savedResult ??
						(await pollRender(options, state, commandId, result));
					finalResults.push({
						...result,
						...polled,
						status:
							polled.status ??
							(polled.outputFile || polled.url ? 'done' : 'submitted'),
						outputFile: polled.outputFile ?? polled.url,
					});
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					diagnostics.push(`Batch ${result.batchId}: ${message}`);
					degradation.push(
						normalizedDegradation(
							'BATCH_RENDER_STATUS_PENDING',
							`批次 ${result.batchId} 已提交但尚未取得最终视频`,
							{batchId: result.batchId, reason: message},
						),
					);
					finalResults.push({
						...result,
						status: 'submitted',
					});
				}
			}
			const doneCount = finalResults.filter(
				(result) =>
					result.status === 'done' || Boolean(result.outputFile ?? result.url),
			).length;
			if (doneCount < batches.length) {
				degradation.push(
					normalizedDegradation(
						'RENDER_OUTPUT_INCOMPLETE',
						`只有 ${doneCount}/${batches.length} 个批次有最终视频 URL`,
						{doneCount, batchCount: batches.length},
					),
				);
				if (
					!options.allowRenderPending &&
					!options.renderStatusUrl &&
					!options.renderResults
				) {
					diagnostics.push('没有 render status 服务或 render results 文件');
				}
			}
			return {
				project,
				result: degradation.length ? 'degraded' : 'completed',
				metadata: {
					batches,
					submittedResults: submitted,
					renderResults: finalResults,
					doneCount,
				},
				artifacts: finalResults.map((result) => ({
					id: `render:${result.batchId}`,
					kind: 'render',
					status:
						result.status === 'done' || result.outputFile
							? 'completed'
							: 'pending',
					url: result.outputFile ?? result.url,
					metadata: {
						renderId: result.renderId,
						bucketName: result.bucketName,
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
			booleanKeys: ['allowRenderPending'],
		});
		if (options.help) {
			usage();
		} else {
			await run(options);
		}
	} catch (error) {
		process.stderr.write(
			`批次渲染失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
