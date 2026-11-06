#!/usr/bin/env node
/* eslint-disable no-undef */

import {
	applyProfileForShot,
	commandBody,
	defaultMotionProfile,
	executeStage,
	findMotionTargets,
	isMainModule,
	normalizedDegradation,
	parseCliArgs,
	readProfile,
	requestJson,
} from './common.mjs';

const usage = () => {
	process.stdout.write(`
按 profile 给镜头和每个部位写入独立运动

参数：
  --production-id <id>
  --production-dir <dir>
  --base-url <url>
  --motion-profile <file>        MotionProfile JSON
  --allow-motion-fallback        单个目标失败时继续
`);
};

const periodFor = (preset, assignment) => {
	if (assignment.period !== undefined) {
		return Number(assignment.period);
	}
	if (preset === 'hair-sway') {
		return 48;
	}
	if (preset === 'float') {
		return 60;
	}
	return 90;
};

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'apply-motion-profile',
		rawOptions,
		inputStage: 'import-layers',
		requiresProject: true,
		handler: async ({options, state, project, commandId}) => {
			const profile = options.motionProfile
				? await readProfile(options.motionProfile)
				: defaultMotionProfile();
			let next = project;
			const assignments = [];
			const diagnostics = [];
			const degradation = [];
			for (const shot of project.shots ?? []) {
				const shotProfile = applyProfileForShot(profile, shot.id);
				const camera = shotProfile.camera;
				if (
					camera?.enabled !== false &&
					camera?.preset &&
					camera.preset !== 'none'
				) {
					const requestId = `${commandId}:${shot.id}:camera`;
					try {
						const response = await requestJson({
							baseUrl: options.baseUrl,
							path: '/api/compose/item/motion',
							productionId: state.productionId,
							commandId: requestId,
							requestId,
							body: commandBody(state, requestId, {
								project: next,
								target: {
									type: 'shot',
									shotId: shot.id,
									presetId: camera.preset,
								},
								mode: camera.mode ?? 'replace',
								parameters: {
									...(camera.parameters ?? {}),
									intensity: camera.intensity ?? 'medium',
								},
								seed: Number(camera.seed ?? 42),
							}),
						});
						next = response.project;
						assignments.push({
							shotId: shot.id,
							scope: 'camera',
							preset: camera.preset,
							intensity: camera.intensity ?? 'medium',
							result: 'applied',
						});
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						diagnostics.push(`Shot ${shot.id} camera: ${message}`);
						degradation.push(
							normalizedDegradation(
								'CAMERA_MOTION_FALLBACK_TO_STATIC',
								`Shot ${shot.id} 镜头运动失败，保留静态镜头`,
								{shotId: shot.id, reason: message},
							),
						);
						if (!options.allowMotionFallback) {
							throw error;
						}
					}
				}

				for (const [semantic, assignment] of Object.entries(
					shotProfile.parts ?? {},
				)) {
					if (
						assignment?.enabled === false ||
						!assignment?.preset ||
						assignment.preset === 'none'
					) {
						continue;
					}
					const targets = findMotionTargets(
						next,
						shot.id,
						assignment.semantic ?? semantic,
					);
					if (targets.length === 0) {
						degradation.push(
							normalizedDegradation(
								'NO_MOTION_TARGET',
								`Shot ${shot.id} 找不到 ${semantic} 对应图层，跳过该部位运动`,
								{shotId: shot.id, semantic},
							),
						);
						assignments.push({
							shotId: shot.id,
							scope: semantic,
							preset: assignment.preset,
							intensity: assignment.intensity ?? 'medium',
							result: 'degraded',
							reason: 'NO_MOTION_TARGET',
						});
						continue;
					}
					for (const target of targets) {
						const requestId = `${commandId}:${shot.id}:${semantic}:${target.id}`;
						try {
							const response = await requestJson({
								baseUrl: options.baseUrl,
								path: '/api/compose/item/motion',
								productionId: state.productionId,
								commandId: requestId,
								requestId,
								body: commandBody(state, requestId, {
									project: next,
									target: {
										type: 'item',
										itemId: target.id,
										presetId: assignment.preset,
									},
									mode: assignment.mode ?? 'replace',
									parameters: {
										...(assignment.parameters ?? {}),
										intensity: assignment.intensity ?? 'medium',
										period: periodFor(assignment.preset, assignment),
									},
									seed: Number(assignment.seed ?? 42),
								}),
							});
							next = response.project;
							assignments.push({
								shotId: shot.id,
								scope: semantic,
								itemId: target.id,
								preset: assignment.preset,
								intensity: assignment.intensity ?? 'medium',
								result: 'applied',
							});
						} catch (error) {
							const message =
								error instanceof Error ? error.message : String(error);
							diagnostics.push(
								`Shot ${shot.id} ${semantic} ${target.id}: ${message}`,
							);
							degradation.push(
								normalizedDegradation(
									'PART_MOTION_FALLBACK_TO_STATIC',
									`Shot ${shot.id} 的 ${semantic} 运动失败，保留静态图层`,
									{
										shotId: shot.id,
										semantic,
										itemId: target.id,
										reason: message,
									},
								),
							);
							if (!options.allowMotionFallback) {
								throw error;
							}
						}
					}
				}
			}
			return {
				project: next,
				result: degradation.length ? 'degraded' : 'completed',
				metadata: {profile, assignments},
				diagnostics,
				degradation,
			};
		},
	});

if (isMainModule(import.meta.url)) {
	try {
		const options = parseCliArgs(process.argv.slice(2), {
			booleanKeys: ['allowMotionFallback'],
		});
		if (options.help) {
			usage();
		} else {
			await run(options);
		}
	} catch (error) {
		process.stderr.write(
			`应用运动 profile 失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
