#!/usr/bin/env node
/* eslint-disable no-undef */

import {
	applyProfileForShot,
	commandBody,
	defaultMotionProfile,
	executeStage,
	findSpriteItem,
	isMainModule,
	normalizedDegradation,
	parseCliArgs,
	readProfile,
	requestJson,
} from './common.mjs';

const usage = () => {
	process.stdout.write(`
给眼睛和嘴巴写入 Sprite 状态动画

参数：
  --production-id <id>
  --production-dir <dir>
  --base-url <url>
  --motion-profile <file>
  --allow-sprite-fallback
`);
};

const spriteAsset = (item, suffix) =>
	(item?.spriteAssetIds ?? []).find((assetId) =>
		assetId.endsWith(`:${suffix}`),
	);

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'apply-sprite-motion',
		rawOptions,
		inputStage: 'apply-motion-profile',
		requiresProject: true,
		handler: async ({options, state, project, commandId, readStage}) => {
			const profile = options.motionProfile
				? await readProfile(options.motionProfile)
				: defaultMotionProfile();
			const dialogueStage = await readStage('add-dialogue');
			const dialogues = dialogueStage.metadata?.dialogues ?? [];
			let next = project;
			const assignments = [];
			const diagnostics = [];
			const degradation = [];
			for (const shot of project.shots ?? []) {
				const shotProfile = applyProfileForShot(profile, shot.id);
				const eye = shotProfile.parts?.eyes;
				if (eye?.enabled !== false && eye?.preset && eye.preset !== 'none') {
					const item = findSpriteItem(next, shot.id, 'eye');
					const openAssetId = spriteAsset(item, 'open');
					const closedAssetId = spriteAsset(item, 'closed');
					if (!item || !openAssetId || !closedAssetId) {
						degradation.push(
							normalizedDegradation(
								'EYE_SPRITE_FALLBACK_TO_STATIC',
								`Shot ${shot.id} 缺少眨眼 Sprite，保留静态眼睛`,
								{shotId: shot.id},
							),
						);
					} else {
						const requestId = `${commandId}:${shot.id}:blink`;
						try {
							const response = await requestJson({
								baseUrl: options.baseUrl,
								path: '/api/compose/item/motion',
								productionId: state.productionId,
								commandId: requestId,
								requestId,
								body: commandBody(state, requestId, {
									project: next,
									target: {type: 'item', itemId: item.id},
									mode: eye.mode ?? 'replace',
									sprite: {
										kind: 'blink',
										openAssetId,
										closedAssetId,
										seed: Number(eye.seed ?? 42),
									},
								}),
							});
							next = response.project;
							assignments.push({
								shotId: shot.id,
								scope: 'eyes',
								itemId: item.id,
								result: 'applied',
							});
						} catch (error) {
							const message =
								error instanceof Error ? error.message : String(error);
							diagnostics.push(`Shot ${shot.id} blink: ${message}`);
							degradation.push(
								normalizedDegradation(
									'EYE_SPRITE_FALLBACK_TO_STATIC',
									`Shot ${shot.id} 眨眼失败，保留静态眼睛`,
									{shotId: shot.id, reason: message},
								),
							);
							if (!options.allowSpriteFallback) {
								throw error;
							}
						}
					}
				}

				const mouth = shotProfile.parts?.mouth;
				if (
					mouth?.enabled !== false &&
					mouth?.preset &&
					mouth.preset !== 'none'
				) {
					const item = findSpriteItem(next, shot.id, 'mouth');
					const closedAssetId = spriteAsset(item, 'closed');
					const halfAssetId = spriteAsset(item, 'half');
					const openAssetId = spriteAsset(item, 'open');
					const dialogueItemIds = dialogues
						.filter((line) => line.shotId === shot.id)
						.map((line) => `dialogue:${shot.id}:${line.lineId}`);
					if (
						!item ||
						!closedAssetId ||
						!openAssetId ||
						dialogueItemIds.length === 0
					) {
						degradation.push(
							normalizedDegradation(
								'MOUTH_SPRITE_FALLBACK_TO_STATIC',
								`Shot ${shot.id} 缺少口型 Sprite 或对白，保留静态嘴巴`,
								{shotId: shot.id},
							),
						);
					} else {
						const requestId = `${commandId}:${shot.id}:mouth`;
						try {
							const response = await requestJson({
								baseUrl: options.baseUrl,
								path: '/api/compose/item/motion',
								productionId: state.productionId,
								commandId: requestId,
								requestId,
								body: commandBody(state, requestId, {
									project: next,
									target: {type: 'item', itemId: item.id},
									mode: mouth.mode ?? 'replace',
									sprite: {
										kind: 'mouth-flap',
										closedAssetId,
										...(halfAssetId ? {halfAssetId} : {}),
										openAssetId,
										dialogueItemIds,
									},
								}),
							});
							next = response.project;
							assignments.push({
								shotId: shot.id,
								scope: 'mouth',
								itemId: item.id,
								result: 'applied',
							});
						} catch (error) {
							const message =
								error instanceof Error ? error.message : String(error);
							diagnostics.push(`Shot ${shot.id} mouth: ${message}`);
							degradation.push(
								normalizedDegradation(
									'MOUTH_SPRITE_FALLBACK_TO_STATIC',
									`Shot ${shot.id} 口型失败，保留静态嘴巴`,
									{shotId: shot.id, reason: message},
								),
							);
							if (!options.allowSpriteFallback) {
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
			booleanKeys: ['allowSpriteFallback'],
		});
		if (options.help) {
			usage();
		} else {
			await run(options);
		}
	} catch (error) {
		process.stderr.write(
			`应用 Sprite motion 失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
