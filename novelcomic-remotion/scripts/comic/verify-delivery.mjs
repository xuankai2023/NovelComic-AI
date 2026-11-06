#!/usr/bin/env node
/* eslint-disable no-undef */

import {
	executeStage,
	isMainModule,
	normalizedDegradation,
	parseCliArgs,
	requestJson,
	StageError,
} from './common.mjs';

const usage = () => {
	process.stdout.write(`
校验交付 ZIP、checksum、文件完整性和播放顺序

参数：
  --production-id <id>
  --production-dir <dir>
  --base-url <url>
  --package-url <url>            覆盖 export-package 返回的 URL
  --allow-unverified             没有 URL 或校验失败时记录并结束
`);
};

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'verify-delivery',
		rawOptions,
		inputStage: 'export-package',
		requiresProject: true,
		handler: async ({options, state, project, input}) => {
			const packageUrl = options.packageUrl ?? input?.metadata?.packageUrl;
			if (!packageUrl) {
				const degradation = [
					normalizedDegradation(
						'DELIVERY_NOT_VERIFIED',
						'export-package 没有返回 packageUrl，无法执行 ZIP 校验',
					),
				];
				if (!options.allowUnverified) {
					throw new StageError(degradation[0].message, {
						code: 'DELIVERY_NOT_VERIFIED',
						retryable: true,
					});
				}
				return {
					project,
					result: 'degraded',
					metadata: {verified: false, packageUrl: null},
					degradation,
				};
			}
			const response = await requestJson({
				baseUrl: options.baseUrl,
				path: '/api/compose/project/verify-package',
				productionId: state.productionId,
				commandId: `verify:${state.productionId}`,
				requestId: `verify:${state.productionId}`,
				body: {packageUrl},
			});
			if (!response.valid) {
				const message = [
					...(response.failures ?? []),
					...(response.missingFiles ?? []).map((file) => `missing:${file}`),
				].join('; ');
				if (!options.allowUnverified) {
					throw new StageError(`交付包校验失败：${message}`, {
						code: 'DELIVERY_INVALID',
						retryable: false,
					});
				}
				return {
					project,
					result: 'degraded',
					metadata: {verified: false, packageUrl, verification: response},
					degradation: [
						normalizedDegradation(
							'DELIVERY_INVALID',
							'交付包校验未通过，但使用 --allow-unverified 继续',
							{
								failures: response.failures,
								missingFiles: response.missingFiles,
							},
						),
					],
				};
			}
			return {
				project,
				statusOverride: 'DELIVERED',
				metadata: {verified: true, packageUrl, verification: response},
				artifacts: [
					{
						id: `delivery:${state.productionId}`,
						kind: 'zip',
						status: 'completed',
						url: packageUrl,
						metadata: {
							checkedFiles: response.checkedFiles,
							playOrder: response.manifest?.playOrder ?? [],
						},
					},
				],
			};
		},
	});

if (isMainModule(import.meta.url)) {
	try {
		const options = parseCliArgs(process.argv.slice(2), {
			booleanKeys: ['allowUnverified'],
		});
		if (options.help) {
			usage();
		} else {
			await run(options);
		}
	} catch (error) {
		process.stderr.write(
			`交付校验失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
