#!/usr/bin/env node
/* eslint-disable no-undef */

import {run as runAddDialogue} from './add-dialogue.mjs';
import {run as runAddSourcePanels} from './add-source-panels.mjs';
import {run as runAddVoice} from './add-voice.mjs';
import {run as runAnalyzePage} from './analyze-page.mjs';
import {run as runApplyMotionProfile} from './apply-motion-profile.mjs';
import {run as runApplySpriteMotion} from './apply-sprite-motion.mjs';
import {
	ensureProduction,
	isMainModule,
	parseCliArgs,
	readJson,
	STAGE_ORDER,
	statePath,
} from './common.mjs';
import {run as runCreateProject} from './create-project.mjs';
import {run as runCreateShots} from './create-shots.mjs';
import {run as runExportPackage} from './export-package.mjs';
import {run as runImportLayers} from './import-layers.mjs';
import {run as runPadProject} from './pad-project.mjs';
import {run as runPlanBatches} from './plan-batches.mjs';
import {run as runPrepareLayers} from './prepare-layers.mjs';
import {run as runPreviewReview} from './preview-review.mjs';
import {run as runRenderBatches} from './render-batches.mjs';
import {run as runValidateProject} from './validate-project.mjs';
import {run as runVerifyDelivery} from './verify-delivery.mjs';

const usage = () => {
	process.stdout.write(`
可恢复的动态漫画生产流程

用法：
  node scripts/comic/run-production.mjs \\
    --source-url https://cdn.example.com/page.png \\
    --production-id prod-001 \\
    --analysis-file artifacts/page-analysis.json \\
    --voice-file artifacts/voices.json \\
    --motion-profile profiles/scene.json \\
    --render --deliver --verify

核心参数：
  --production-id <id>           同时作为 productionId/projectId
  --production-dir <dir>         阶段产物目录
  --source-url <url>             原图 HTTPS 地址
  --analysis-file <file>         PageAnalysis/PanelSpec JSON
  --analyzer-url <url>           分格/OCR 服务地址
  --ocr-file <file>              OCR/对白 JSON
  --voice-file <file>            已生成音频清单
  --voice-service-url <url>      TTS 服务地址
  --layer-file <file>            已生成 LayerPackage
  --clean-plate-file <file>      Clean Plate 请求清单
  --motion-profile <file>        每个部位独立运动配置

恢复和交付：
  --from <stage>                 从指定阶段开始，如 prepare-layers
  --force                        重跑已完成阶段
  --render                       提交批次渲染
  --render-status-url <url>      轮询渲染状态
  --render-results <file>        读取外部渲染结果
  --deliver                      生成真实 ZIP
  --verify                       校验 ZIP 并推进 DELIVERED
  --review-status <status>       pending|approved|needs-rework

降级默认开启：
  没有 TTS、分格、拆层、补图、预览或渲染状态服务时，脚本会保存降级记录；
  使用 --no-allow-no-voice 等参数可以把对应阶段改为失败。
`);
};

const startIndexFor = (value) => {
	if (!value) {
		return 0;
	}
	const normalized = String(value).replace(/^\d+-/, '');
	const index = STAGE_ORDER.indexOf(normalized);
	if (index < 0) {
		throw new Error(`未知阶段 ${value}。可选：${STAGE_ORDER.join(', ')}`);
	}
	return index;
};

const defaultOptions = {
	allowNoVoice: true,
	allowLayerFallback: true,
	allowMotionFallback: true,
	allowSpriteFallback: true,
	allowPreviewFallback: true,
	allowRenderPending: true,
	allowIncompletePackage: true,
	preview: true,
	render: false,
	deliver: false,
	verify: false,
};

export const run = async (rawOptions = {}) => {
	const options = {...defaultOptions, ...rawOptions};
	const {options: normalized} = await ensureProduction(options);
	const startIndex = startIndexFor(normalized.fromStage ?? normalized.from);
	const runners = [
		['analyze-page', runAnalyzePage],
		['create-project', runCreateProject],
		['create-shots', runCreateShots],
		['add-source-panels', runAddSourcePanels],
		['add-dialogue', runAddDialogue],
		['add-voice', runAddVoice],
		['prepare-layers', runPrepareLayers],
		['import-layers', runImportLayers],
		['apply-motion-profile', runApplyMotionProfile],
		['apply-sprite-motion', runApplySpriteMotion],
		['pad-project', runPadProject],
		['validate-project', runValidateProject],
		['preview-review', runPreviewReview],
		['plan-batches', runPlanBatches],
		['render-batches', runRenderBatches],
		['export-package', runExportPackage],
		['verify-delivery', runVerifyDelivery],
	];

	for (const [index, [stage, runner]] of runners.entries()) {
		if (index < startIndex) {
			continue;
		}
		if (stage === 'render-batches' && !normalized.render) {
			process.stdout.write('[SKIP] render-batches：未指定 --render\n');
			continue;
		}
		if (stage === 'preview-review' && normalized.preview === false) {
			process.stdout.write('[SKIP] preview-review：使用 --no-preview\n');
			continue;
		}
		if (stage === 'export-package' && !normalized.deliver) {
			process.stdout.write('[SKIP] export-package：未指定 --deliver\n');
			continue;
		}
		if (stage === 'verify-delivery' && !normalized.verify) {
			process.stdout.write('[SKIP] verify-delivery：未指定 --verify\n');
			continue;
		}
		const currentState = await readJson(statePath(normalized.productionDir));
		if (
			!normalized.force &&
			currentState.completedStages.includes(stage) &&
			currentState.stageRuns?.[stage]?.length
		) {
			process.stdout.write(`[SKIP] ${stage}：已有成功阶段产物\n`);
			continue;
		}
		process.stdout.write(`\n[RUN] ${stage}\n`);
		await runner(normalized);
	}

	const finalState = await readJson(statePath(normalized.productionDir));
	process.stdout.write(
		`\n生产流程完成：${finalState.productionId}\n` +
			`状态：${finalState.status}\n` +
			`已完成：${finalState.completedStages.join(', ') || '无'}\n` +
			`产物目录：${normalized.productionDir}\n`,
	);
	return finalState;
};

if (isMainModule(import.meta.url)) {
	try {
		const options = parseCliArgs(process.argv.slice(2), {
			booleanKeys: [
				'force',
				'allowNoVoice',
				'allowLayerFallback',
				'allowMotionFallback',
				'allowSpriteFallback',
				'allowPreviewFallback',
				'allowRenderPending',
				'allowIncompletePackage',
				'preview',
				'render',
				'deliver',
				'verify',
			],
		});
		if (options.help) {
			usage();
		} else {
			await run(options);
		}
	} catch (error) {
		process.stderr.write(
			`生产流程失败：${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
