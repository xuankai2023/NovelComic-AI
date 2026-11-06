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
生成联系表帧计划、首中末帧预览并记录审片状态

参数：
  --production-id <id>
  --production-dir <dir>
  --base-url <url>
  --preview-width <number>      默认 640
  --review-status <status>      pending|approved|needs-rework
  --allow-preview-fallback      预览失败时继续流水线
`);
};

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'preview-review',
		rawOptions,
		inputStage: 'validate-project',
		requiresProject: true,
		handler: async ({options, state, project, commandId}) => {
			const diagnostics = [];
			const degradation = [];
			let frames = [];
			let previews = [];
			try {
				const contact = await requestJson({
					baseUrl: options.baseUrl,
					path: '/api/compose/project/contact-sheet',
					productionId: state.productionId,
					commandId,
					requestId: commandId,
					body: commandBody(state, commandId, {project}),
				});
				frames = contact.frames ?? [];
				for (const entry of frames) {
					try {
						const preview = await requestJson({
							baseUrl: options.baseUrl,
							path: '/api/compose/project/preview-frame',
							productionId: state.productionId,
							commandId: `${commandId}:${entry.shotId}:${entry.frame}`,
							requestId: `${commandId}:${entry.shotId}:${entry.frame}`,
							body: commandBody(state, commandId, {
								project,
								frame: entry.frame,
								width: Number(options.previewWidth ?? 640),
								format: 'png',
							}),
						});
						previews.push({
							...entry,
							...preview,
						});
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						diagnostics.push(
							`Shot ${entry.shotId} frame ${entry.frame}: ${message}`,
						);
						degradation.push(
							normalizedDegradation(
								'PREVIEW_FRAME_FAILED',
								`Shot ${entry.shotId} 预览失败`,
								{shotId: entry.shotId, frame: entry.frame, reason: message},
							),
						);
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				diagnostics.push(message);
				degradation.push(
					normalizedDegradation(
						'CONTACT_SHEET_FAILED',
						'联系表帧计划或预览服务失败',
						{reason: message},
					),
				);
				if (!options.allowPreviewFallback) {
					throw error;
				}
			}
			return {
				project,
				result: degradation.length ? 'degraded' : 'completed',
				metadata: {
					frames,
					previews,
					reviewStatus: options.reviewStatus ?? 'pending',
					contactSheetReady: frames.length > 0,
				},
				artifacts: [
					{
						id: `preview:${state.productionId}`,
						kind: 'preview',
						status: previews.length > 0 ? 'completed' : 'failed',
						metadata: {
							frameCount: frames.length,
							previewCount: previews.length,
						},
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
			booleanKeys: ['allowPreviewFallback'],
		});
		if (options.help) {
			usage();
		} else {
			await run(options);
		}
	} catch (error) {
		process.stderr.write(
			`预览审片失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
