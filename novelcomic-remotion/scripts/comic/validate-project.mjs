#!/usr/bin/env node
/* eslint-disable no-undef */

import {
	commandBody,
	executeStage,
	isMainModule,
	parseCliArgs,
	requestJson,
	StageError,
} from './common.mjs';

const usage = () => {
	process.stdout.write(`
校验当前工程

参数：
  --production-id <id>
  --production-dir <dir>
  --base-url <url>
  --allow-invalid                记录问题但允许流水线继续
`);
};

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'validate-project',
		rawOptions,
		inputStage: 'pad-project',
		requiresProject: true,
		handler: async ({options, state, project, commandId}) => {
			const response = await requestJson({
				baseUrl: options.baseUrl,
				path: '/api/compose/project/validate',
				productionId: state.productionId,
				commandId,
				requestId: commandId,
				body: commandBody(state, commandId, {project}),
			});
			const issues = response.issues ?? [];
			const errors = issues.filter((issue) => issue.severity === 'error');
			if (response.valid === false || errors.length > 0) {
				const message = `工程校验失败：${
					errors.map((issue) => `${issue.code}: ${issue.message}`).join('; ') ||
					'valid=false'
				}`;
				if (!options.allowInvalid) {
					throw new StageError(message, {
						code: 'PROJECT_INVALID',
						retryable: false,
						issues,
					});
				}
			}
			return {
				project,
				result: errors.length > 0 ? 'degraded' : 'completed',
				metadata: {
					valid: errors.length === 0,
					issues,
					warnings: issues.filter((issue) => issue.severity === 'warning'),
				},
				diagnostics: issues.map(
					(issue) => `${issue.severity}: ${issue.code}: ${issue.message}`,
				),
				...(errors.length > 0
					? {
							degradation: [
								{
									code: 'PROJECT_VALIDATION_OVERRIDDEN',
									message: '工程存在错误，但使用 --allow-invalid 继续',
									issues: errors,
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
			booleanKeys: ['allowInvalid'],
		});
		if (options.help) {
			usage();
		} else {
			await run(options);
		}
	} catch (error) {
		process.stderr.write(
			`工程校验失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
