#!/usr/bin/env node
/* eslint-disable no-undef */

import {
	assertHttpsUrl,
	executeStage,
	hashContent,
	isMainModule,
	normalizedDegradation,
	parseCliArgs,
	readJson,
	requestJson,
	requireValue,
} from './common.mjs';

const usage = () => {
	process.stdout.write(`
分析单页漫画

用法：
  node scripts/comic/analyze-page.mjs --source-url <HTTPS图片>
  node scripts/comic/analyze-page.mjs --analysis-file <PageAnalysis.json>

参数：
  --source-url <url>             原图地址
  --analysis-file <file>         已有 PageAnalysis JSON
  --analyzer-url <url>           外部分格/OCR 服务地址
  --ocr-file <file>              单独的 OCR/对白 JSON
  --production-id <id>           生产 ID
  --production-dir <dir>         产物目录
  --width <number>               原图宽度，默认 1080
  --height <number>              原图高度，默认 1920
  --reading-direction <rtl|ltr> 阅读方向，默认 ltr
`);
};

const rectFrom = (value, fallback) => {
	if (!value || typeof value !== 'object') {
		return fallback;
	}
	const source = value;
	return {
		x: Number(source.x ?? source.left ?? fallback.x),
		y: Number(source.y ?? source.top ?? fallback.y),
		width: Number(source.width ?? fallback.width),
		height: Number(source.height ?? fallback.height),
	};
};

const normalizePanel = (panel, index, options, sourceUrl) => {
	const bounds = rectFrom(panel.bounds ?? panel.bbox, {
		x: 0,
		y: 0,
		width: options.width,
		height: options.height,
	});
	const panelId = String(
		panel.panelId ?? panel.id ?? `panel-${String(index + 1).padStart(3, '0')}`,
	);
	return {
		panelId,
		pageId: String(panel.pageId ?? hashContent(sourceUrl).slice(0, 16)),
		order: Number(panel.order ?? index),
		readingOrder: Number(panel.readingOrder ?? index),
		bounds,
		imageUrl: panel.imageUrl ?? panel.cropUrl ?? sourceUrl,
		cropUrl: panel.cropUrl ?? panel.imageUrl ?? sourceUrl,
		width: Number(panel.width ?? bounds.width ?? options.width),
		height: Number(panel.height ?? bounds.height ?? options.height),
		confidence: Number(panel.confidence ?? 1),
	};
};

const normalizeDialogues = (raw) => {
	const lines = Array.isArray(raw)
		? raw
		: Array.isArray(raw?.dialogues)
			? raw.dialogues
			: Array.isArray(raw?.lines)
				? raw.lines
				: [];
	return lines
		.map((line, index) => ({
			lineId: String(
				line.lineId ?? line.id ?? `line-${String(index + 1).padStart(3, '0')}`,
			),
			panelId: line.panelId ? String(line.panelId) : undefined,
			text: String(line.text ?? line.content ?? ''),
			speakerId: String(line.speakerId ?? line.characterId ?? 'unknown'),
			readingOrder: Number(line.readingOrder ?? index),
			bubbleBounds: line.bubbleBounds ?? line.bounds ?? undefined,
			confidence: Number(line.confidence ?? 1),
			from: line.from,
			durationInFrames: line.durationInFrames,
			voiceProfileId: line.voiceProfileId,
		}))
		.filter((line) => line.text.trim().length > 0);
};

const normalizeAnalysis = (raw, options, sourceUrl) => {
	const value = raw?.analysis ?? raw ?? {};
	const panels =
		Array.isArray(value.panels) && value.panels.length > 0
			? value.panels.map((panel, index) =>
					normalizePanel(panel, index, options, sourceUrl),
				)
			: [normalizePanel({}, 0, options, sourceUrl)];
	const pageId = String(value.pageId ?? panels[0].pageId);
	return {
		schemaVersion: 1,
		pageId,
		sourceUrl,
		pageWidth: Number(value.pageWidth ?? options.width),
		pageHeight: Number(value.pageHeight ?? options.height),
		readingDirection:
			value.readingDirection ?? options.readingDirection ?? 'ltr',
		panels: panels
			.map((panel) => ({...panel, pageId}))
			.sort(
				(left, right) =>
					left.readingOrder - right.readingOrder || left.order - right.order,
			),
		dialogues: normalizeDialogues(value.dialogues ?? value.lines),
		confidence: Number(value.confidence ?? 1),
		fallback: value.fallback ?? 'none',
		analyzerVersion: value.analyzerVersion,
	};
};

export const run = async (rawOptions = {}) => {
	const options = {
		...rawOptions,
		sourceUrl: rawOptions.sourceUrl,
		readingDirection: rawOptions.readingDirection ?? 'ltr',
	};
	return executeStage({
		stage: 'analyze-page',
		rawOptions: options,
		handler: async ({options: stageOptions, state}) => {
			let sourceUrl = stageOptions.sourceUrl;
			let raw = null;
			if (stageOptions.analysisFile) {
				raw = await readJson(stageOptions.analysisFile);
				sourceUrl = raw?.sourceUrl ?? raw?.analysis?.sourceUrl ?? sourceUrl;
			} else if (stageOptions.analyzerUrl) {
				sourceUrl = requireValue(stageOptions, 'sourceUrl', '--source-url');
				sourceUrl = assertHttpsUrl(sourceUrl, '--source-url');
				raw = await requestJson({
					path: stageOptions.analyzerUrl,
					baseUrl: stageOptions.baseUrl,
					productionId: state.productionId,
					requestId: `analyze:${state.productionId}`,
					body: {
						productionId: state.productionId,
						pageId: hashContent(sourceUrl).slice(0, 16),
						sourceUrl,
						width: stageOptions.width,
						height: stageOptions.height,
						readingDirection: stageOptions.readingDirection,
					},
				});
			} else {
				sourceUrl = requireValue(stageOptions, 'sourceUrl', '--source-url');
				sourceUrl = assertHttpsUrl(sourceUrl, '--source-url');
			}
			if (!sourceUrl) {
				throw new Error('PageAnalysis 或 --source-url 至少需要一个');
			}
			sourceUrl = assertHttpsUrl(sourceUrl, 'sourceUrl');

			let analysis = normalizeAnalysis(raw, stageOptions, sourceUrl);
			if (stageOptions.ocrFile) {
				const ocr = await readJson(stageOptions.ocrFile);
				analysis = {
					...analysis,
					dialogues: normalizeDialogues(ocr),
				};
			}

			const degradation = [];
			const diagnostics = [];
			if (!raw && !stageOptions.analyzerUrl) {
				analysis = {...analysis, fallback: 'full-page'};
				degradation.push(
					normalizedDegradation(
						'PAGE_ANALYSIS_FALLBACK_TO_FULL_PAGE',
						'未配置分格分析服务，使用整页作为一个 PanelSpec',
					),
				);
				diagnostics.push('PAGE_ANALYZER_NOT_CONFIGURED');
			}
			if (analysis.dialogues.length === 0) {
				diagnostics.push('NO_OCR_DIALOGUE');
			}
			return {
				result: degradation.length ? 'degraded' : 'completed',
				metadata: {pageAnalysis: analysis},
				artifacts: [
					{
						id: `page-analysis:${state.productionId}`,
						kind: 'page-analysis',
						status: 'completed',
						metadata: {
							pageId: analysis.pageId,
							panelCount: analysis.panels.length,
							dialogueCount: analysis.dialogues.length,
						},
					},
				],
				diagnostics,
				degradation,
			};
		},
	});
};

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
			`分析失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
