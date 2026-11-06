#!/usr/bin/env node
/* eslint-disable no-undef */

import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT_DIR = resolve(
	fileURLToPath(new URL('../..', import.meta.url)),
);
export const DEFAULT_BASE_URL = 'http://localhost:3034';
export const DEFAULT_ARTIFACT_ROOT = join(ROOT_DIR, 'artifacts', 'comic');
export const STAGE_ORDER = [
	'analyze-page',
	'create-project',
	'create-shots',
	'add-source-panels',
	'add-dialogue',
	'add-voice',
	'prepare-layers',
	'import-layers',
	'apply-motion-profile',
	'apply-sprite-motion',
	'pad-project',
	'validate-project',
	'preview-review',
	'plan-batches',
	'render-batches',
	'export-package',
	'verify-delivery',
];

export const PRODUCTION_STATUSES = [
	'CREATED',
	'ANALYZING',
	'DIALOGUE_READY',
	'VOICE_READY',
	'LAYERS_READY',
	'COMPOSING',
	'VALIDATING',
	'REVIEWING',
	'RENDERING',
	'PACKAGING',
	'DELIVERED',
	'FAILED',
	'PERMANENT_FAILED',
	'CANCELLED',
];

export class StageError extends Error {
	constructor(message, details = {}) {
		super(message);
		this.name = 'StageError';
		this.code = details.code ?? 'STAGE_FAILED';
		this.retryable = details.retryable ?? false;
		this.status = details.status;
		this.details = details;
	}
}

const camelCase = (value) =>
	value.replace(/-([a-z])/g, (_, character) => character.toUpperCase());

export const parseCliArgs = (
	argv,
	{booleanKeys = [], defaults = {}, aliases = {}} = {},
) => {
	const booleans = new Set(booleanKeys);
	const options = {...defaults};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith('--')) {
			const positional = options._ ?? [];
			positional.push(argument);
			options._ = positional;
			continue;
		}

		const rawKey = argument.slice(2);
		const key = camelCase(aliases[rawKey] ?? rawKey);
		if (key === 'help' || key === 'h') {
			options.help = true;
			continue;
		}

		if (booleans.has(key) || rawKey.startsWith('no-')) {
			options[rawKey.startsWith('no-') ? camelCase(rawKey.slice(3)) : key] =
				!rawKey.startsWith('no-');
			continue;
		}

		const value = argv[index + 1];
		if (value === undefined || value.startsWith('--')) {
			throw new StageError(`${argument} 需要一个参数`, {
				code: 'INVALID_ARGUMENT',
			});
		}
		index += 1;
		if (options[key] === undefined) {
			options[key] = value;
			continue;
		}
		if (Array.isArray(options[key])) {
			options[key].push(value);
		} else {
			options[key] = [options[key], value];
		}
	}

	return options;
};

export const requireValue = (options, key, label = `--${key}`) => {
	const value = options[key];
	if (value === undefined || value === null || String(value).trim() === '') {
		throw new StageError(`${label} 必填`, {code: 'INVALID_ARGUMENT'});
	}
	return value;
};

export const numberValue = (value, label, {integer = false, min} = {}) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
		throw new StageError(
			`${label} 必须是${integer ? '整数' : '数字'}：${value}`,
			{
				code: 'INVALID_ARGUMENT',
			},
		);
	}
	if (min !== undefined && parsed < min) {
		throw new StageError(`${label} 不能小于 ${min}：${value}`, {
			code: 'INVALID_ARGUMENT',
		});
	}
	return parsed;
};

export const readJson = async (filename) => {
	try {
		return JSON.parse(await readFile(resolve(filename), 'utf8'));
	} catch (error) {
		throw new StageError(
			`无法读取 JSON 文件 ${filename}：${
				error instanceof Error ? error.message : String(error)
			}`,
			{code: 'INVALID_JSON'},
		);
	}
};

export const readOptionalJson = async (filename) => {
	if (!filename || !existsSync(resolve(filename))) {
		return null;
	}
	return readJson(filename);
};

export const writeJson = async (filename, value) => {
	const target = resolve(filename);
	await mkdir(dirname(target), {recursive: true});
	await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
	return target;
};

export const stableStringify = (value) => {
	if (value === undefined) {
		return 'null';
	}
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value) ?? 'null';
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(',')}]`;
	}
	const record = value;
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(',')}}`;
};

export const hashContent = (value) =>
	createHash('sha256').update(stableStringify(value)).digest('hex');

export const assertHttpsUrl = (value, label = 'URL') => {
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new StageError(`${label} 不是合法 URL：${value}`, {
			code: 'INVALID_URL',
		});
	}
	if (parsed.protocol !== 'https:') {
		throw new StageError(`${label} 必须使用 HTTPS：${value}`, {
			code: 'INVALID_URL',
		});
	}
	return parsed.href;
};

export const normalizeOptions = (raw = {}) => {
	const productionId =
		raw.productionId ||
		raw.projectId ||
		`prod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const productionDir = resolve(
		raw.productionDir ?? join(DEFAULT_ARTIFACT_ROOT, productionId),
	);
	return {
		...raw,
		productionId,
		projectId: raw.projectId ?? productionId,
		productionDir,
		baseUrl: (raw.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
		width: Number(raw.width ?? 1080),
		height: Number(raw.height ?? 1920),
		fps: Number(raw.fps ?? 30),
		durationSeconds: Number(raw.durationSeconds ?? 8),
		pollIntervalMs: Number(raw.pollIntervalMs ?? raw.pollInterval ?? 2000),
		pollTimeoutMs: Number(
			raw.pollTimeoutMs ?? raw.pollTimeout ?? 15 * 60 * 1000,
		),
	};
};

const emptyState = (options) => ({
	schemaVersion: 1,
	type: 'comic-production-state',
	productionId: options.productionId,
	projectId: options.projectId,
	status: 'CREATED',
	currentStage: null,
	lastStage: null,
	lastProjectFile: null,
	completedStages: [],
	stageRuns: {},
	artifacts: [],
	degradation: [],
	errors: [],
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
});

export const stagePath = (productionDir, stage) =>
	join(productionDir, 'stages', `${stage}.json`);

export const projectPath = (productionDir, stage) =>
	join(productionDir, 'projects', `${stage}.json`);

export const reportPath = (productionDir, stage) =>
	join(productionDir, 'reports', `${stage}.json`);

export const statePath = (productionDir) => join(productionDir, 'state.json');

export const ensureProduction = async (rawOptions = {}) => {
	const options = normalizeOptions(rawOptions);
	await mkdir(options.productionDir, {recursive: true});
	let state;
	if (existsSync(statePath(options.productionDir))) {
		state = await readJson(statePath(options.productionDir));
		if (
			state.productionId !== options.productionId ||
			state.projectId !== options.projectId
		) {
			throw new StageError(
				`生产目录与 productionId/projectId 不匹配：${options.productionDir}`,
				{code: 'PRODUCTION_ID_MISMATCH'},
			);
		}
	} else {
		state = emptyState(options);
		await writeJson(statePath(options.productionDir), state);
	}
	return {options, state};
};

export const readStage = async (productionDir, stage) => {
	const filename = stagePath(productionDir, stage);
	if (!existsSync(filename)) {
		throw new StageError(`找不到阶段产物：${filename}`, {
			code: 'MISSING_STAGE_OUTPUT',
		});
	}
	return readJson(filename);
};

export const readLatestStage = async (productionDir, state) => {
	if (!state.lastStage) {
		return null;
	}
	return readStage(productionDir, state.lastStage);
};

export const readLatestProject = async (productionDir, state) => {
	if (!state.lastProjectFile || !existsSync(state.lastProjectFile)) {
		const latest = await readLatestStage(productionDir, state);
		return latest?.project ?? null;
	}
	return readJson(state.lastProjectFile);
};

export const commandIdFor = (state, stage, inputHash) => {
	const ordinal = String(Math.max(1, STAGE_ORDER.indexOf(stage) + 1)).padStart(
		2,
		'0',
	);
	return `compose:${state.projectId}:${ordinal}:${stage}:${inputHash.slice(0, 16)}`;
};

export const commandBody = (
	state,
	commandId,
	body,
	{expectedRevision} = {},
) => ({
	...body,
	clientRequestId: commandId,
	...(expectedRevision !== undefined
		? {expectedRevision}
		: state.revision !== undefined
			? {expectedRevision: state.revision}
			: {}),
});

const responsePayload = async (response) => {
	const text = await response.text();
	if (!text) {
		return {};
	}
	try {
		return JSON.parse(text);
	} catch {
		return {raw: text};
	}
};

export const requestJson = async ({
	baseUrl,
	path,
	body,
	method = 'POST',
	requestId,
	productionId,
	commandId,
	timeoutMs = 120000,
	headers = {},
}) => {
	const url =
		path.startsWith('http://') || path.startsWith('https://')
			? path
			: `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			method,
			headers: {
				...(method === 'POST' ? {'content-type': 'application/json'} : {}),
				'x-request-id': requestId ?? commandId ?? `comic:${Date.now()}`,
				...(productionId ? {'x-production-id': productionId} : {}),
				...(commandId ? {'x-command-id': commandId} : {}),
				...headers,
			},
			...(body === undefined ? {} : {body: JSON.stringify(body)}),
			signal: controller.signal,
		});
		const payload = await responsePayload(response);
		if (
			!response.ok ||
			(payload && typeof payload === 'object' && payload.type === 'error')
		) {
			const details = payload && typeof payload === 'object' ? payload : {};
			throw new StageError(
				`${method} ${path} ${response.status}: ${
					details.message ?? details.error ?? details.raw ?? response.statusText
				}`,
				{
					code: details.code ?? `HTTP_${response.status}`,
					retryable: details.retryable ?? response.status >= 500,
					status: response.status,
					response: payload,
				},
			);
		}
		return payload;
	} catch (error) {
		if (error instanceof StageError) {
			throw error;
		}
		if (error?.name === 'AbortError') {
			throw new StageError(`请求超时：${method} ${path}`, {
				code: 'REQUEST_TIMEOUT',
				retryable: true,
			});
		}
		throw new StageError(
			`请求失败：${method} ${path}：${
				error instanceof Error ? error.message : String(error)
			}`,
			{code: 'NETWORK_ERROR', retryable: true},
		);
	} finally {
		clearTimeout(timer);
	}
};

export const sleep = (milliseconds) =>
	new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export const poll = async (
	operation,
	{timeoutMs = 15 * 60 * 1000, intervalMs = 2000, label = '异步任务'} = {},
) => {
	const startedAt = Date.now();
	let attempt = 0;
	while (Date.now() - startedAt <= timeoutMs) {
		attempt += 1;
		const value = await operation({attempt});
		if (value?.status !== 'queued' && value?.status !== 'running') {
			return value;
		}
		await sleep(intervalMs);
	}
	throw new StageError(`${label}轮询超时`, {
		code: 'POLL_TIMEOUT',
		retryable: true,
	});
};

const stageStatusFor = (stage, result) => {
	if (result === 'failed') {
		return 'FAILED';
	}
	if (stage === 'analyze-page') {
		return 'ANALYZING';
	}
	if (stage === 'add-dialogue') {
		return 'DIALOGUE_READY';
	}
	if (stage === 'add-voice') {
		return 'VOICE_READY';
	}
	if (stage === 'prepare-layers' || stage === 'import-layers') {
		return 'LAYERS_READY';
	}
	if (
		[
			'create-project',
			'create-shots',
			'add-source-panels',
			'apply-motion-profile',
			'apply-sprite-motion',
			'pad-project',
		].includes(stage)
	) {
		return 'COMPOSING';
	}
	if (stage === 'validate-project') {
		return 'VALIDATING';
	}
	if (stage === 'preview-review') {
		return 'REVIEWING';
	}
	if (stage === 'render-batches') {
		return 'RENDERING';
	}
	if (stage === 'export-package' || stage === 'verify-delivery') {
		return 'PACKAGING';
	}
	return 'COMPOSING';
};

const summaryFor = (result) => {
	const summary = {...result};
	delete summary.project;
	delete summary.analysis;
	delete summary.layerPackages;
	delete summary.dialogues;
	delete summary.voices;
	return summary;
};

export const persistStage = async ({
	options,
	state,
	stage,
	inputHash,
	commandId,
	result = 'completed',
	project,
	artifacts = [],
	diagnostics = [],
	degradation = [],
	metadata = {},
	statusOverride,
	error,
}) => {
	const previousProjectFile = state.lastProjectFile;
	const output = {
		schemaVersion: 1,
		type: 'comic-stage-output',
		productionId: state.productionId,
		projectId: state.projectId,
		stage,
		inputHash,
		commandId,
		result,
		project,
		artifacts,
		diagnostics,
		degradation,
		metadata,
		...(error
			? {
					error: {
						message: error.message ?? String(error),
						code: error.code ?? 'STAGE_FAILED',
						retryable: Boolean(error.retryable),
					},
				}
			: {}),
		generatedAt: new Date().toISOString(),
	};
	await writeJson(stagePath(options.productionDir, stage), output);
	if (project) {
		await writeJson(projectPath(options.productionDir, stage), project);
	}
	await writeJson(reportPath(options.productionDir, stage), summaryFor(output));

	const stageRun = {
		inputHash,
		commandId,
		result,
		outputFile: stagePath(options.productionDir, stage),
		reportFile: reportPath(options.productionDir, stage),
		projectFile: project ? projectPath(options.productionDir, stage) : null,
		updatedAt: output.generatedAt,
	};
	state.stageRuns[stage] = [...(state.stageRuns[stage] ?? []), stageRun];
	state.currentStage = stage;
	state.lastStage = stage;
	state.status = statusOverride ?? stageStatusFor(stage, result);
	if (project) {
		state.lastProjectFile = projectPath(options.productionDir, stage);
	} else if (previousProjectFile) {
		state.lastProjectFile = previousProjectFile;
	}
	if (result === 'completed' || result === 'degraded') {
		if (!state.completedStages.includes(stage)) {
			state.completedStages.push(stage);
		}
	}
	state.artifacts = [...state.artifacts, ...artifacts];
	state.degradation = [...state.degradation, ...degradation];
	if (error) {
		state.errors.push({
			stage,
			message: error.message ?? String(error),
			code: error.code ?? 'STAGE_FAILED',
			retryable: Boolean(error.retryable),
			at: output.generatedAt,
		});
	}
	state.updatedAt = output.generatedAt;
	await writeJson(statePath(options.productionDir), state);
	return output;
};

export const executeStage = async ({
	stage,
	rawOptions = {},
	inputStage,
	requiresProject = false,
	handler,
}) => {
	const {options, state} = await ensureProduction(rawOptions);
	const input = inputStage
		? await readStage(options.productionDir, inputStage)
		: await readLatestStage(options.productionDir, state);
	const project =
		input?.project ?? (await readLatestProject(options.productionDir, state));
	if (requiresProject && !project) {
		throw new StageError(`${stage} 缺少输入工程 JSON`, {
			code: 'MISSING_PROJECT',
		});
	}
	const inputHash = hashContent({
		stage,
		options: {
			...options,
			output: undefined,
			productionDir: undefined,
		},
		inputHash: input?.inputHash ?? null,
		projectHash: project ? hashContent(project) : null,
	});
	const commandId = commandIdFor(state, stage, inputHash);
	try {
		const value = await handler({
			options,
			state,
			input,
			project,
			inputHash,
			commandId,
			readStage: (name) => readStage(options.productionDir, name),
		});
		const result =
			value.result ?? (value.degradation?.length ? 'degraded' : 'completed');
		return persistStage({
			options,
			state,
			stage,
			inputHash,
			commandId,
			...value,
			result,
		});
	} catch (error) {
		const failure =
			error instanceof StageError
				? error
				: new StageError(
						error instanceof Error ? error.message : String(error),
						{
							code: 'STAGE_FAILED',
							retryable: false,
						},
					);
		await persistStage({
			options,
			state,
			stage,
			inputHash,
			commandId,
			result: 'failed',
			project,
			diagnostics: [],
			degradation: [],
			error: failure,
		});
		throw failure;
	}
};

export const printFailure = (error) => {
	process.stderr.write(
		`阶段失败：${error instanceof Error ? error.message : String(error)}\n`,
	);
};

export const isMainModule = (metaUrl) =>
	process.argv[1] === fileURLToPath(new URL(metaUrl));

export const buildExportFiles = (project) => {
	const files = [];
	for (const [index, asset] of Object.values(project.assets ?? {}).entries()) {
		const id = asset.id ?? `asset-${index}`;
		const category =
			asset.type === 'audio'
				? 'audio'
				: id.includes(':panel')
					? 'panel'
					: 'layer';
		files.push({
			path: `assets/${id}/${asset.filename ?? `${id}.bin`}`,
			category,
			order: index,
			...(asset.remoteUrl ? {url: asset.remoteUrl} : {}),
		});
	}
	return files;
};

export const projectDuration = (project) =>
	Math.max(
		...(project?.shots ?? []).map((shot) => shot.from + shot.durationInFrames),
		...Object.values(project?.items ?? {}).map(
			(item) => item.from + item.durationInFrames,
		),
		[0],
	);

export const imageItemForTrack = (project, track) => {
	for (const itemId of track?.items ?? []) {
		const item = project.items?.[itemId];
		if (item?.type === 'image') {
			return item;
		}
	}
	return null;
};

const semanticCandidates = (semantic) => {
	const aliases = {
		body: ['body'],
		head: ['head'],
		hair: ['hair'],
		eyes: ['eye-open', 'eye-closed', 'eye'],
		mouth: ['mouth-closed', 'mouth-half', 'mouth-open', 'mouth'],
		foreground: ['foreground'],
		background: ['background'],
		effect: ['effect'],
	};
	return aliases[semantic] ?? [semantic];
};

export const findMotionTargets = (project, shotId, semantic) => {
	const candidates = new Set(semanticCandidates(semantic));
	return project.tracks
		.filter(
			(track) =>
				track.shotId === shotId &&
				track.role === 'cutout' &&
				(typeof track.semantic === 'string'
					? candidates.has(track.semantic) ||
						(semantic === 'eyes' && track.semantic.startsWith('eye-')) ||
						(semantic === 'mouth' && track.semantic.startsWith('mouth-'))
					: false),
		)
		.map((track) => imageItemForTrack(project, track))
		.filter(Boolean);
};

export const findSpriteItem = (project, shotId, group) => {
	const target = project.tracks.find(
		(track) =>
			track.shotId === shotId &&
			track.role === 'cutout' &&
			typeof track.semantic === 'string' &&
			(group === 'eye'
				? track.semantic.startsWith('eye-')
				: track.semantic.startsWith('mouth-')),
	);
	return imageItemForTrack(project, target);
};

export const getShot = (project, shotId) =>
	(project.shots ?? []).find((shot) => shot.id === shotId) ?? null;

export const defaultMotionProfile = () => ({
	camera: {preset: 'camera-push', intensity: 'medium', enabled: true},
	parts: {},
});

export const readProfile = async (filename) => {
	if (!filename) {
		return defaultMotionProfile();
	}
	const value = await readJson(filename);
	return {
		...defaultMotionProfile(),
		...value,
		parts: {...(value.parts ?? {})},
	};
};

export const applyProfileForShot = (profile, shotId) => ({
	...profile,
	...(profile.shots?.[shotId] ?? {}),
	parts: {...(profile.parts ?? {}), ...(profile.shots?.[shotId]?.parts ?? {})},
});

export const normalizedDegradation = (code, message, details = {}) => ({
	code,
	message,
	...details,
	at: new Date().toISOString(),
});
