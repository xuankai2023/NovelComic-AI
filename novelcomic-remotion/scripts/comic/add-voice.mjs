#!/usr/bin/env node
/* eslint-disable no-undef */

import {
	commandBody,
	executeStage,
	isMainModule,
	normalizedDegradation,
	parseCliArgs,
	readJson,
	requestJson,
} from './common.mjs';

const usage = () => {
	process.stdout.write(`
调用真实配音服务并写入 dialogue/voice

参数：
  --production-id <id>
  --production-dir <dir>
  --base-url <url>
  --voice-file <file>            已生成音频清单 JSON
  --voice-service-url <url>      TTS 服务地址
  --default-voice-id <id>        TTS 服务默认音色
  --allow-no-voice               没有音频时降级为字幕
`);
};

const normalizeVoices = (value, dialogues) => {
	const source = value?.voices ?? value?.lines ?? value ?? [];
	if (!Array.isArray(source)) {
		return [];
	}
	const byLine = new Map(dialogues.map((line) => [line.lineId, line]));
	return source
		.map((voice) => {
			const line = byLine.get(String(voice.lineId));
			if (!line) {
				return null;
			}
			const audioUrl = voice.audioUrl ?? voice.url;
			if (!audioUrl) {
				return null;
			}
			return {
				shotId: String(voice.shotId ?? line.shotId),
				lineId: line.lineId,
				audioUrl,
				from: Number(voice.from ?? line.from),
				durationInFrames: Number(
					voice.durationInFrames ?? line.durationInFrames,
				),
				...(voice.sourceStartInSeconds !== undefined
					? {sourceStartInSeconds: Number(voice.sourceStartInSeconds)}
					: {}),
				...(voice.decibelAdjustment !== undefined
					? {decibelAdjustment: Number(voice.decibelAdjustment)}
					: {}),
				...((voice.characterId ?? line.characterId)
					? {characterId: voice.characterId ?? line.characterId}
					: {}),
				...((voice.voiceProfileId ?? line.voiceProfileId)
					? {
							voiceProfileId: voice.voiceProfileId ?? line.voiceProfileId,
						}
					: {}),
			};
		})
		.filter(Boolean);
};

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'add-voice',
		rawOptions,
		inputStage: 'add-dialogue',
		requiresProject: true,
		handler: async ({options, state, project, commandId, input}) => {
			const dialogues = input?.metadata?.dialogues ?? [];
			let voiceValue = null;
			if (options.voiceFile) {
				voiceValue = await readJson(options.voiceFile);
			} else if (options.voiceServiceUrl && dialogues.length > 0) {
				voiceValue = await requestJson({
					path: options.voiceServiceUrl,
					baseUrl: options.baseUrl,
					productionId: state.productionId,
					commandId,
					requestId: commandId,
					body: {
						productionId: state.productionId,
						projectId: state.projectId,
						defaultVoiceId: options.defaultVoiceId,
						dialogues,
					},
				});
			}
			const voices = normalizeVoices(voiceValue, dialogues);
			if (voices.length === 0) {
				if (!options.allowNoVoice) {
					throw new Error(
						'没有可用音频。请提供 --voice-file 或 --voice-service-url；如需降级请加 --allow-no-voice',
					);
				}
				return {
					project,
					result: 'degraded',
					metadata: {voices: []},
					diagnostics: ['VOICE_PROVIDER_NOT_CONFIGURED'],
					degradation: [
						normalizedDegradation(
							'VOICE_FALLBACK_TO_SUBTITLE',
							'真实配音不可用，保留字幕并跳过音频轨',
						),
					],
				};
			}
			const response = await requestJson({
				baseUrl: options.baseUrl,
				path: '/api/compose/dialogue/voice',
				productionId: state.productionId,
				commandId,
				requestId: commandId,
				body: commandBody(state, commandId, {project, voices}),
			});
			return {
				project: response.project,
				metadata: {voices},
				artifacts: [
					{
						id: `voice:${state.productionId}`,
						kind: 'dialogue-audio',
						status: 'completed',
						metadata: {
							lineCount: voices.length,
							audioUrls: voices.map((voice) => voice.audioUrl),
						},
					},
				],
			};
		},
	});

if (isMainModule(import.meta.url)) {
	try {
		const options = parseCliArgs(process.argv.slice(2), {
			booleanKeys: ['allowNoVoice'],
		});
		if (options.help) {
			usage();
		} else {
			await run(options);
		}
	} catch (error) {
		process.stderr.write(
			`真实配音失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
