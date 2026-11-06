#!/usr/bin/env node
/* eslint-disable no-undef */

import {
	commandBody,
	executeStage,
	getShot,
	isMainModule,
	parseCliArgs,
	readJson,
	requestJson,
} from './common.mjs';

const usage = () => {
	process.stdout.write(`
根据 OCR/气泡结果写入对白

参数：
  --production-id <id>
  --production-dir <dir>
  --base-url <url>
  --dialogue-file <file>         覆盖或补充分析阶段的 dialogues
  --default-speaker <id>         默认说话人，默认 unknown
`);
};

const analysisFrom = (stage) =>
	stage?.metadata?.pageAnalysis ?? stage?.analysis;

const normalizeLines = (analysis, dialogueValue) => {
	const source =
		dialogueValue?.dialogues ??
		dialogueValue?.lines ??
		dialogueValue ??
		analysis.dialogues ??
		[];
	if (!Array.isArray(source)) {
		return [];
	}
	return source
		.map((line, index) => ({
			lineId: String(
				line.lineId ?? line.id ?? `line-${String(index + 1).padStart(3, '0')}`,
			),
			panelId: line.panelId ? String(line.panelId) : undefined,
			text: String(line.text ?? line.content ?? '').trim(),
			speakerId: String(line.speakerId ?? line.characterId ?? 'unknown'),
			voiceProfileId: line.voiceProfileId,
			from: line.from,
			durationInFrames: line.durationInFrames,
			confidence: Number(line.confidence ?? 1),
			bubbleBounds: line.bubbleBounds ?? line.bounds,
		}))
		.filter((line) => line.text.length > 0);
};

export const run = async (rawOptions = {}) =>
	executeStage({
		stage: 'add-dialogue',
		rawOptions,
		inputStage: 'add-source-panels',
		requiresProject: true,
		handler: async ({options, state, project, commandId, readStage}) => {
			const analysis = analysisFrom(await readStage('analyze-page'));
			const shotStage = await readStage('create-shots');
			const shotByPanel = new Map(
				(shotStage.metadata?.shots ?? []).map((shot) => [
					shot.panelId,
					shot.shotId,
				]),
			);
			const externalDialogue = options.dialogueFile
				? await readJson(options.dialogueFile)
				: null;
			const sourceLines = normalizeLines(analysis, externalDialogue);
			const lines = sourceLines.map((line, index) => {
				const shotId =
					line.shotId ??
					shotByPanel.get(line.panelId) ??
					shotStage.metadata?.shots?.[index]?.shotId;
				const shot = shotId ? getShot(project, shotId) : null;
				if (!shot) {
					throw new Error(
						`对白 ${line.lineId} 没有找到对应 Shot${line.panelId ? `：${line.panelId}` : ''}`,
					);
				}
				const defaultFrom =
					shot.from + Math.round(shot.durationInFrames * 0.15);
				const maximumDuration = Math.max(
					1,
					shot.from + shot.durationInFrames - defaultFrom,
				);
				const durationInFrames = Math.min(
					Math.max(
						1,
						Number(line.durationInFrames) ||
							Math.round(shot.durationInFrames * 0.5),
					),
					maximumDuration,
				);
				const from = Math.max(
					shot.from,
					Math.min(
						shot.from + shot.durationInFrames - durationInFrames,
						Number(line.from) || defaultFrom,
					),
				);
				return {
					lineId: line.lineId,
					shotId,
					text: line.text,
					from,
					durationInFrames,
					characterId: line.speakerId || options.defaultSpeaker || 'unknown',
					...(line.voiceProfileId ? {voiceProfileId: line.voiceProfileId} : {}),
					metadata: {
						panelId: line.panelId,
						confidence: line.confidence,
						bubbleBounds: line.bubbleBounds,
					},
				};
			});

			if (lines.length === 0) {
				return {
					project,
					result: 'degraded',
					metadata: {dialogues: [], ocr: 'empty'},
					diagnostics: ['NO_DIALOGUE_LINES'],
					degradation: [
						{
							code: 'DIALOGUE_FALLBACK_TO_SILENT',
							message: '没有识别到可写入的对白，保留画面并跳过字幕/配音轨',
						},
					],
				};
			}

			const response = await requestJson({
				baseUrl: options.baseUrl,
				path: '/api/compose/dialogue/add',
				productionId: state.productionId,
				commandId,
				requestId: commandId,
				body: commandBody(state, commandId, {
					project,
					lines: lines.map((line) => {
						const copy = {...line};
						delete copy.metadata;
						return copy;
					}),
				}),
			});
			return {
				project: response.project,
				metadata: {dialogues: lines},
				artifacts: [
					{
						id: `dialogue:${state.productionId}`,
						kind: 'ocr',
						status: 'completed',
						metadata: {lineCount: lines.length},
					},
				],
			};
		},
	});

if (isMainModule(import.meta.url)) {
	try {
		const options = parseCliArgs(process.argv.slice(2));
		if (options.help) {
			usage();
		} else {
			await run(options);
		}
	} catch (error) {
		process.stderr.write(
			`添加对白失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
