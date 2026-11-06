'use client';

import React, {useCallback, useState} from 'react';

type VideoEntry = {
	remoteUrl: string;
	filename: string;
	durationInSeconds: string;
	width: string;
	height: string;
	hasAudioTrack: boolean;
	size: string;
	mimeType: string;
	remoteFileKey: string;
	probed: boolean;
	probing: boolean;
	uploading: boolean;
	uploadProgress: string;
};

const emptyVideo = (): VideoEntry => ({
	remoteUrl: '',
	filename: '',
	durationInSeconds: '',
	width: '',
	height: '',
	hasAudioTrack: false,
	size: '',
	mimeType: '',
	remoteFileKey: '',
	probed: false,
	probing: false,
	uploading: false,
	uploadProgress: '',
});

async function uploadFileToS3(
	file: File,
): Promise<{readUrl: string; fileKey: string}> {
	const presignRes = await fetch('/api/upload', {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({
			contentType: file.type,
			size: file.size,
			filename: file.name,
		}),
	});
	if (!presignRes.ok) {
		const err = await presignRes.json();
		throw new Error(err.message || 'Failed to get upload URL');
	}
	const {presignedUrl, readUrl, fileKey} = await presignRes.json();

	const putRes = await fetch(presignedUrl, {
		method: 'PUT',
		body: file,
		headers: {'Content-Type': file.type},
	});
	if (!putRes.ok) {
		throw new Error(`Upload failed: ${putRes.status}`);
	}

	return {readUrl, fileKey};
}

async function probeUrl(url: string) {
	const res = await fetch('/api/compose/probe', {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({url}),
	});
	return res.json();
}

const videoEntryToPayload = (v: VideoEntry) => {
	const payload: Record<string, unknown> = {
		remoteUrl: v.remoteUrl,
	};
	if (v.filename) payload.filename = v.filename;
	if (v.durationInSeconds)
		payload.durationInSeconds = Number(v.durationInSeconds);
	if (v.width) payload.width = Number(v.width);
	if (v.height) payload.height = Number(v.height);
	if (v.hasAudioTrack) payload.hasAudioTrack = true;
	if (v.size) payload.size = Number(v.size);
	if (v.mimeType) payload.mimeType = v.mimeType;
	if (v.remoteFileKey) payload.remoteFileKey = v.remoteFileKey;
	return payload;
};

const parseProjectPayload = (projectJson: string): Record<string, unknown> => {
	const raw = JSON.parse(projectJson);
	return raw.project ?? raw;
};

const addNumberIfPresent = (
	target: Record<string, unknown>,
	key: string,
	value: string,
) => {
	if (value.trim()) target[key] = Number(value);
};

const CAPTION_STYLES = [
	'default',
	'colored-words',
	'scaling-words',
	'animated-background',
] as const;

const HIGHLIGHT_PRESETS = [
	{label: '亮绿', value: '#00FF00'},
	{label: '淡粉', value: '#FFB6C1'},
	{label: '明黄', value: '#FFFF00'},
	{label: '柔紫', value: '#C9A8FF'},
	{label: '冰蓝', value: '#7DF9FF'},
] as const;

const LANGUAGE_OPTIONS = [
	{key: 'auto' as const, label: '自动检测'},
	{key: 'zh' as const, label: '中文（强烈建议中文场景显式选）'},
	{key: 'en' as const, label: '英文'},
];

export default function TestApiPage() {
	return (
		<div className="mx-auto min-h-screen max-w-[1000px] bg-neutral-100 px-5 py-8 font-sans text-gray-900">
			<h1 className="mb-1 text-2xl font-bold text-gray-900">
				Compose API 测试工具
			</h1>
			<p className="mb-8 text-sm text-gray-500">
				测试视频拼接、视频加字幕以及最终渲染合成 API。
			</p>
			<div className="flex flex-col gap-10">
				<ConcatSection />
				<ProjectSummarySection />
				<ItemEditSection />
				<AudioAddSection />
				<SubtitleSection />
				<OverlaySection />
				<ProjectValidateSection />
				<RenderSection />
			</div>
		</div>
	);
}

// ==================== Concat Section ====================

function ConcatSection() {
	const [videos, setVideos] = useState<VideoEntry[]>([emptyVideo()]);
	const [width, setWidth] = useState('1080');
	const [height, setHeight] = useState('1920');
	const [fps, setFps] = useState('30');
	const [existingProject, setExistingProject] = useState('');
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [result, setResult] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const addVideo = useCallback(
		() => setVideos((prev) => [...prev, emptyVideo()]),
		[],
	);
	const removeVideo = useCallback(
		(idx: number) => setVideos((prev) => prev.filter((_, i) => i !== idx)),
		[],
	);
	const updateVideo = useCallback(
		(idx: number, field: keyof VideoEntry, value: string | boolean) => {
			setVideos((prev) =>
				prev.map((v, i) => (i === idx ? {...v, [field]: value} : v)),
			);
		},
		[],
	);

	const probeVideoAt = useCallback(
		async (idx: number) => {
			const url = videos[idx].remoteUrl;
			if (!url) return;
			setVideos((prev) =>
				prev.map((v, i) => (i === idx ? {...v, probing: true} : v)),
			);
			try {
				const json = await probeUrl(url);
				if (json.type === 'success') {
					setVideos((prev) =>
						prev.map((v, i) =>
							i === idx
								? {
										...v,
										durationInSeconds: String(json.durationInSeconds),
										width: String(json.width),
										height: String(json.height),
										hasAudioTrack: json.hasAudioTrack,
										mimeType: json.mimeType || v.mimeType,
										size: json.size ? String(json.size) : v.size,
										filename: json.name || v.filename,
										probed: true,
										probing: false,
									}
								: v,
						),
					);
				} else {
					alert('探测失败: ' + json.error);
					setVideos((prev) =>
						prev.map((v, i) => (i === idx ? {...v, probing: false} : v)),
					);
				}
			} catch {
				alert('探测请求失败');
				setVideos((prev) =>
					prev.map((v, i) => (i === idx ? {...v, probing: false} : v)),
				);
			}
		},
		[videos],
	);

	const handleUploadComplete = useCallback(
		(idx: number, data: Partial<VideoEntry>) => {
			setVideos((prev) =>
				prev.map((v, i) => (i === idx ? {...v, ...data} : v)),
			);
		},
		[],
	);

	const submit = useCallback(async () => {
		setLoading(true);
		setError(null);
		setResult(null);
		try {
			const body: Record<string, unknown> = {
				videos: videos.map(videoEntryToPayload),
				compositionWidth: Number(width),
				compositionHeight: Number(height),
				fps: Number(fps),
			};
			if (existingProject.trim()) {
				body.existingProject = JSON.parse(existingProject);
			}
			const res = await fetch('/api/compose/concat', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify(body),
			});
			const json = await res.json();
			setResult(JSON.stringify(json, null, 2));
			if (json.type === 'error') setError(json.error);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Request failed');
		} finally {
			setLoading(false);
		}
	}, [videos, width, height, fps, existingProject]);

	return (
		<SectionCard title="视频拼接 — POST /api/compose/concat">
			<div className="flex flex-col gap-4">
				{videos.map((v, idx) => (
					<VideoUrlCard
						key={idx}
						index={idx}
						video={v}
						onChange={updateVideo}
						onProbe={probeVideoAt}
						onRemove={videos.length > 1 ? removeVideo : undefined}
						onUploadComplete={handleUploadComplete}
						showAdvanced={showAdvanced}
					/>
				))}

				<div className="flex items-center gap-3">
					<button
						onClick={addVideo}
						className="cursor-pointer border-none bg-transparent p-0 text-sm font-medium text-blue-600"
					>
						+ 添加视频
					</button>
					<button
						onClick={() => setShowAdvanced(!showAdvanced)}
						className="cursor-pointer border-none bg-transparent p-0 text-[13px] font-medium text-gray-500"
					>
						{showAdvanced ? '收起高级选项' : '展开高级选项'}
					</button>
				</div>

				{showAdvanced && (
					<>
						<div className="flex flex-wrap gap-3">
							<InputField
								label="画布宽度"
								value={width}
								onChange={setWidth}
								w={120}
							/>
							<InputField
								label="画布高度"
								value={height}
								onChange={setHeight}
								w={120}
							/>
							<InputField label="FPS" value={fps} onChange={setFps} w={80} />
						</div>
						<TextareaField
							label="已有工程 JSON（可选）"
							value={existingProject}
							onChange={setExistingProject}
							placeholder="粘贴完整工程 JSON，将在此基础上追加视频..."
							rows={3}
						/>
					</>
				)}

				<ActionButton onClick={submit} loading={loading}>
					拼接
				</ActionButton>

				{error && <ErrorBox message={error} />}
				{result && <ResultBox json={result} />}
			</div>
		</SectionCard>
	);
}

// ==================== Project Summary Section ====================

function ProjectSummarySection() {
	const [projectJson, setProjectJson] = useState('');
	const [result, setResult] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = useCallback(async () => {
		setLoading(true);
		setError(null);
		setResult(null);
		try {
			if (!projectJson.trim()) throw new Error('请粘贴工程 JSON');
			const res = await fetch('/api/compose/project/summary', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({project: parseProjectPayload(projectJson)}),
			});
			const json = await res.json();
			setResult(JSON.stringify(json, null, 2));
			if (json.type === 'error') setError(json.error);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Request failed');
		} finally {
			setLoading(false);
		}
	}, [projectJson]);

	return (
		<SectionCard title="工程摘要 — POST /api/compose/project/summary">
			<div className="flex flex-col gap-4">
				<TextareaField
					label="工程 JSON"
					value={projectJson}
					onChange={setProjectJson}
					rows={6}
					placeholder="粘贴完整工程 JSON 或 API 返回结果（会自动提取 .project 字段）..."
				/>
				<p className="-mt-2 text-xs text-gray-400">
					用于查看 track / item / itemId / 时间码 / 音量，方便后续精剪。
				</p>
				<ActionButton onClick={submit} loading={loading}>
					生成摘要
				</ActionButton>
				{error && <ErrorBox message={error} />}
				{result && <ResultBox json={result} />}
			</div>
		</SectionCard>
	);
}

// ==================== Item Edit Section ====================

function ItemEditSection() {
	const [projectJson, setProjectJson] = useState('');
	const [itemId, setItemId] = useState('');
	const [fromMs, setFromMs] = useState('');
	const [durationMs, setDurationMs] = useState('');
	const [sourceStartMs, setSourceStartMs] = useState('');
	const [decibelAdjustment, setDecibelAdjustment] = useState('');
	const [audioFadeInMs, setAudioFadeInMs] = useState('');
	const [audioFadeOutMs, setAudioFadeOutMs] = useState('');
	const [fadeInMs, setFadeInMs] = useState('');
	const [fadeOutMs, setFadeOutMs] = useState('');
	const [result, setResult] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = useCallback(async () => {
		setLoading(true);
		setError(null);
		setResult(null);
		try {
			if (!projectJson.trim()) throw new Error('请粘贴工程 JSON');
			if (!itemId.trim()) throw new Error('请输入 itemId');

			const patch: Record<string, unknown> = {};
			addNumberIfPresent(patch, 'fromMs', fromMs);
			addNumberIfPresent(patch, 'durationMs', durationMs);
			addNumberIfPresent(patch, 'sourceStartMs', sourceStartMs);
			addNumberIfPresent(patch, 'decibelAdjustment', decibelAdjustment);
			addNumberIfPresent(patch, 'audioFadeInMs', audioFadeInMs);
			addNumberIfPresent(patch, 'audioFadeOutMs', audioFadeOutMs);
			addNumberIfPresent(patch, 'fadeInMs', fadeInMs);
			addNumberIfPresent(patch, 'fadeOutMs', fadeOutMs);

			const res = await fetch('/api/compose/item/edit', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({
					project: parseProjectPayload(projectJson),
					itemId: itemId.trim(),
					patch,
				}),
			});
			const json = await res.json();
			setResult(JSON.stringify(json, null, 2));
			if (json.type === 'error') setError(json.error);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Request failed');
		} finally {
			setLoading(false);
		}
	}, [
		audioFadeInMs,
		audioFadeOutMs,
		decibelAdjustment,
		durationMs,
		fadeInMs,
		fadeOutMs,
		fromMs,
		itemId,
		projectJson,
		sourceStartMs,
	]);

	return (
		<SectionCard title="元素精剪 — POST /api/compose/item/edit">
			<div className="flex flex-col gap-4">
				<TextareaField
					label="工程 JSON"
					value={projectJson}
					onChange={setProjectJson}
					rows={5}
					placeholder="建议先调用工程摘要接口，拿到要编辑的 itemId..."
				/>
				<InputField label="itemId" value={itemId} onChange={setItemId} />
				<div className="grid grid-cols-2 gap-3">
					<InputField
						label="时间线开始 fromMs（可选）"
						value={fromMs}
						onChange={setFromMs}
					/>
					<InputField
						label="持续时间 durationMs（可选）"
						value={durationMs}
						onChange={setDurationMs}
					/>
					<InputField
						label="素材起点 sourceStartMs（可选）"
						value={sourceStartMs}
						onChange={setSourceStartMs}
					/>
					<InputField
						label="音量 dB（可选）"
						value={decibelAdjustment}
						onChange={setDecibelAdjustment}
					/>
					<InputField
						label="音频淡入 audioFadeInMs（可选）"
						value={audioFadeInMs}
						onChange={setAudioFadeInMs}
					/>
					<InputField
						label="音频淡出 audioFadeOutMs（可选）"
						value={audioFadeOutMs}
						onChange={setAudioFadeOutMs}
					/>
					<InputField
						label="画面淡入 fadeInMs（可选）"
						value={fadeInMs}
						onChange={setFadeInMs}
					/>
					<InputField
						label="画面淡出 fadeOutMs（可选）"
						value={fadeOutMs}
						onChange={setFadeOutMs}
					/>
				</div>
				<ActionButton onClick={submit} loading={loading}>
					应用编辑
				</ActionButton>
				{error && <ErrorBox message={error} />}
				{result && <ResultBox json={result} />}
			</div>
		</SectionCard>
	);
}

// ==================== Audio Add Section ====================

function AudioAddSection() {
	const [projectJson, setProjectJson] = useState('');
	const [audioUrl, setAudioUrl] = useState('');
	const [startMs, setStartMs] = useState('0');
	const [sourceStartMs, setSourceStartMs] = useState('0');
	const [durationMs, setDurationMs] = useState('');
	const [decibelAdjustment, setDecibelAdjustment] = useState('-15');
	const [fadeInMs, setFadeInMs] = useState('500');
	const [fadeOutMs, setFadeOutMs] = useState('1500');
	const [result, setResult] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = useCallback(async () => {
		setLoading(true);
		setError(null);
		setResult(null);
		try {
			if (!projectJson.trim()) throw new Error('请粘贴工程 JSON');
			if (!audioUrl.trim()) throw new Error('请输入 audioUrl');

			const body: Record<string, unknown> = {
				project: parseProjectPayload(projectJson),
				audioUrl: audioUrl.trim(),
			};
			addNumberIfPresent(body, 'startMs', startMs);
			addNumberIfPresent(body, 'sourceStartMs', sourceStartMs);
			addNumberIfPresent(body, 'durationMs', durationMs);
			addNumberIfPresent(body, 'decibelAdjustment', decibelAdjustment);
			addNumberIfPresent(body, 'fadeInMs', fadeInMs);
			addNumberIfPresent(body, 'fadeOutMs', fadeOutMs);

			const res = await fetch('/api/compose/audio/add', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify(body),
			});
			const json = await res.json();
			setResult(JSON.stringify(json, null, 2));
			if (json.type === 'error') setError(json.error);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Request failed');
		} finally {
			setLoading(false);
		}
	}, [
		audioUrl,
		decibelAdjustment,
		durationMs,
		fadeInMs,
		fadeOutMs,
		projectJson,
		sourceStartMs,
		startMs,
	]);

	return (
		<SectionCard title="添加音频 / BGM — POST /api/compose/audio/add">
			<div className="flex flex-col gap-4">
				<TextareaField
					label="工程 JSON"
					value={projectJson}
					onChange={setProjectJson}
					rows={5}
					placeholder="粘贴已有 project，将在其基础上添加音频轨..."
				/>
				<InputField
					label="音频 URL"
					value={audioUrl}
					onChange={setAudioUrl}
					placeholder="https://example.com/bgm.mp3"
				/>
				<div className="grid grid-cols-2 gap-3">
					<InputField
						label="开始时间 startMs"
						value={startMs}
						onChange={setStartMs}
					/>
					<InputField
						label="素材起点 sourceStartMs"
						value={sourceStartMs}
						onChange={setSourceStartMs}
					/>
					<InputField
						label="持续时间 durationMs（空=自动到工程结束）"
						value={durationMs}
						onChange={setDurationMs}
					/>
					<InputField
						label="音量 dB"
						value={decibelAdjustment}
						onChange={setDecibelAdjustment}
					/>
					<InputField
						label="淡入 fadeInMs"
						value={fadeInMs}
						onChange={setFadeInMs}
					/>
					<InputField
						label="淡出 fadeOutMs"
						value={fadeOutMs}
						onChange={setFadeOutMs}
					/>
				</div>
				<ActionButton onClick={submit} loading={loading}>
					添加音频
				</ActionButton>
				{error && <ErrorBox message={error} />}
				{result && <ResultBox json={result} />}
			</div>
		</SectionCard>
	);
}

// ==================== Subtitle Section ====================

type SubInputMode = 'videoUrl' | 'project';

function SubtitleSection() {
	const [inputMode, setInputMode] = useState<SubInputMode>('videoUrl');
	const [video, setVideo] = useState<VideoEntry>(emptyVideo());
	const [projectJson, setProjectJson] = useState('');
	const [itemIds, setItemIds] = useState('');
	const [captionStyle, setCaptionStyle] = useState('animated-background');
	const [captionPosition, setCaptionPosition] = useState<
		'top' | 'center' | 'bottom'
	>('bottom');
	const [language, setLanguage] = useState<'auto' | 'zh' | 'en'>('auto');
	const [provider, setProvider] = useState<'elevenlabs' | 'openai'>(
		'elevenlabs',
	);
	const [highlightColor, setHighlightColor] = useState('#00FF00');
	const [letterSpacing, setLetterSpacing] = useState('-0.2');
	const [result, setResult] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const updateVideoField = useCallback(
		(field: keyof VideoEntry, value: string | boolean) => {
			setVideo((prev) => ({...prev, [field]: value}));
		},
		[],
	);

	const probeVideoSingle = useCallback(async () => {
		if (!video.remoteUrl) return;
		setVideo((prev) => ({...prev, probing: true}));
		try {
			const json = await probeUrl(video.remoteUrl);
			if (json.type === 'success') {
				setVideo((prev) => ({
					...prev,
					durationInSeconds: String(json.durationInSeconds),
					width: String(json.width),
					height: String(json.height),
					hasAudioTrack: json.hasAudioTrack,
					mimeType: json.mimeType || prev.mimeType,
					size: json.size ? String(json.size) : prev.size,
					filename: json.name || prev.filename,
					probed: true,
					probing: false,
				}));
			} else {
				alert('探测失败: ' + json.error);
				setVideo((prev) => ({...prev, probing: false}));
			}
		} catch {
			alert('探测请求失败');
			setVideo((prev) => ({...prev, probing: false}));
		}
	}, [video.remoteUrl]);

	const handleUploadCompleteSingle = useCallback(
		(_idx: number, data: Partial<VideoEntry>) => {
			setVideo((prev) => ({...prev, ...data}));
		},
		[],
	);

	const submit = useCallback(async () => {
		setLoading(true);
		setError(null);
		setResult(null);
		try {
			const options: Record<string, unknown> = {};
			if (highlightColor.trim()) options.highlightColor = highlightColor.trim();
			if (letterSpacing.trim() !== '' && Number.isFinite(Number(letterSpacing))) {
				options.letterSpacing = Number(letterSpacing);
			}

			const body: Record<string, unknown> = {
				captionStyle,
				captionPosition,
				language,
				provider,
				options,
			};

			if (inputMode === 'videoUrl') {
				if (!video.remoteUrl) {
					throw new Error('请提供视频 URL 或上传本地文件');
				}
				body.videoUrl = video.remoteUrl;
			} else {
				if (!projectJson.trim()) {
					throw new Error('请粘贴工程 JSON');
				}
				body.project = parseProjectPayload(projectJson);
				if (itemIds.trim()) {
					body.itemIds = itemIds
						.split(/[\n,]/)
						.map((id) => id.trim())
						.filter(Boolean);
				}
			}

			const res = await fetch('/api/compose/subtitle', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify(body),
			});
			const json = await res.json();
			setResult(JSON.stringify(json, null, 2));
			if (json.type === 'error') setError(json.error);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Request failed');
		} finally {
			setLoading(false);
		}
	}, [
		captionPosition,
		captionStyle,
		highlightColor,
		inputMode,
		itemIds,
		language,
		letterSpacing,
		projectJson,
		provider,
		video.remoteUrl,
	]);

	return (
		<SectionCard title="视频加字幕 — POST /api/compose/subtitle">
			<div className="flex flex-col gap-4">
				<div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-800">
					<div className="mb-1 font-semibold">本接口已品牌化固化</div>
					字体（Montserrat）、字重（900 Black）、行高（1.2）、文字颜色（#FFFFFF）、描边（#0A0909 / 8px）、翻页时长（1000ms）
					全部由服务端注入，不在本页暴露。可调的只有：
					<span className="font-mono">captionStyle</span>、
					<span className="font-mono">captionPosition</span>、
					<span className="font-mono">language</span>、
					<span className="font-mono">provider</span>、
					<span className="font-mono">options.highlightColor</span>、
					<span className="font-mono">options.letterSpacing</span>。服务端还会自动
					繁体 → 简体 + 过滤 emoji 和所有标点。
				</div>

				<div>
					<label className="mb-1 block text-xs font-medium text-gray-600">
						输入方式
					</label>
					<div className="mt-1 flex gap-2">
						{[
							{key: 'videoUrl' as const, label: '给视频 URL，自动识别字幕'},
							{key: 'project' as const, label: '给工程 JSON，自动识别字幕'},
						].map((m) => (
							<button
								key={m.key}
								onClick={() => setInputMode(m.key)}
								className={`cursor-pointer rounded-full border px-3 py-1.5 text-[13px] transition-colors ${
									inputMode === m.key
										? 'border-blue-600 bg-blue-600 text-white'
										: 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
								}`}
							>
								{m.label}
							</button>
						))}
					</div>
				</div>

				{inputMode === 'videoUrl' && (
					<>
						<VideoUrlCard
							index={0}
							video={video}
							onChange={(_, field, value) => updateVideoField(field, value)}
							onProbe={() => probeVideoSingle()}
							onUploadComplete={handleUploadCompleteSingle}
							showAdvanced={false}
						/>
						<p className="-mt-2 text-xs text-gray-400">
							自动探测视频尺寸作为画布大小，自动识别音频生成字幕
						</p>
					</>
				)}

				{inputMode === 'project' && (
					<>
						<TextareaField
							label="工程 JSON（会自动提取 .project 字段）"
							value={projectJson}
							onChange={setProjectJson}
							rows={6}
							placeholder="粘贴拼接 API 返回的结果或完整工程 JSON..."
						/>
						<p className="-mt-2 text-xs text-gray-400">
							默认识别工程中的所有可用视频/音频轨道；填写 itemIds 后只识别指定
							item。
						</p>
						<InputField
							label="指定 itemIds（可选，逗号或换行分隔）"
							value={itemIds}
							onChange={setItemIds}
							placeholder="video_item_id_1, audio_item_id_2"
						/>
					</>
				)}

				<div className="flex gap-4">
					<div className="flex-1">
						<label className="mb-1 block text-xs font-medium text-gray-600">
							字幕样式 captionStyle（默认 animated-background）
						</label>
						<select
							value={captionStyle}
							onChange={(e) => setCaptionStyle(e.target.value)}
							className="mt-1 w-full cursor-pointer rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[13px] text-gray-900 outline-none"
						>
							{CAPTION_STYLES.map((s) => (
								<option key={s} value={s}>
									{s}
								</option>
							))}
						</select>
					</div>
					<div className="flex-1">
						<label className="mb-1 block text-xs font-medium text-gray-600">
							字幕位置 captionPosition
						</label>
						<div className="mt-1 flex gap-1.5">
							{[
								{key: 'top' as const, label: '上方'},
								{key: 'center' as const, label: '居中'},
								{key: 'bottom' as const, label: '下方'},
							].map((p) => (
								<button
									key={p.key}
									onClick={() => setCaptionPosition(p.key)}
									className={`flex-1 cursor-pointer rounded-md border px-2 py-1.5 text-[13px] transition-colors ${
										captionPosition === p.key
											? 'border-blue-600 bg-blue-600 text-white'
											: 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
									}`}
								>
									{p.label}
								</button>
							))}
						</div>
					</div>
				</div>

				<div className="flex gap-4">
					<div className="flex-1">
						<label className="mb-1 block text-xs font-medium text-gray-600">
							识别语言 language（中文场景强烈建议显式选 zh）
						</label>
						<div className="mt-1 flex gap-1.5">
							{LANGUAGE_OPTIONS.map((l) => (
								<button
									key={l.key}
									onClick={() => {
										setLanguage(l.key);
										if (l.key === 'zh') setLetterSpacing('-10');
										else if (l.key === 'en') setLetterSpacing('-0.2');
									}}
									className={`flex-1 cursor-pointer rounded-md border px-2 py-1.5 text-[13px] transition-colors ${
										language === l.key
											? 'border-blue-600 bg-blue-600 text-white'
											: 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
									}`}
								>
									{l.label}
								</button>
							))}
						</div>
					</div>
					<div className="flex-1">
						<label className="mb-1 block text-xs font-medium text-gray-600">
							识别厂商 provider
						</label>
						<div className="mt-1 flex gap-1.5">
							{[
								{key: 'elevenlabs' as const, label: 'ElevenLabs Scribe（默认）'},
								{key: 'openai' as const, label: 'OpenAI Whisper'},
							].map((p) => (
								<button
									key={p.key}
									onClick={() => setProvider(p.key)}
									className={`flex-1 cursor-pointer rounded-md border px-2 py-1.5 text-[13px] transition-colors ${
										provider === p.key
											? 'border-blue-600 bg-blue-600 text-white'
											: 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
									}`}
								>
									{p.label}
								</button>
							))}
						</div>
					</div>
				</div>

				<div>
					<label className="mb-1 block text-xs font-medium text-gray-600">
						高亮色 options.highlightColor（5 个品牌色任选，也可自定义）
					</label>
					<div className="mt-1 flex flex-wrap items-center gap-2">
						{HIGHLIGHT_PRESETS.map((c) => (
							<button
								key={c.value}
								onClick={() => setHighlightColor(c.value)}
								className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] transition-colors ${
									highlightColor.toUpperCase() === c.value
										? 'border-blue-600 ring-2 ring-blue-200'
										: 'border-gray-300 hover:border-gray-400'
								}`}
							>
								<span
									className="inline-block h-3.5 w-3.5 rounded-sm border border-gray-300"
									style={{backgroundColor: c.value}}
								/>
								{c.label}
								<span className="font-mono text-[11px] text-gray-500">
									{c.value}
								</span>
							</button>
						))}
						<input
							type="text"
							value={highlightColor}
							onChange={(e) => setHighlightColor(e.target.value)}
							placeholder="自定义 hex 颜色"
							className="ml-2 w-[160px] rounded-md border border-gray-300 bg-white px-2.5 py-1.5 font-mono text-[13px] text-gray-900 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
						/>
					</div>
				</div>

				<div className="grid grid-cols-2 gap-3">
					<InputField
						label="字距 options.letterSpacing（英文推荐 -0.2 / 中文推荐 -10）"
						value={letterSpacing}
						onChange={setLetterSpacing}
						placeholder="-0.2"
					/>
				</div>

				<ActionButton onClick={submit} loading={loading}>
					{loading ? '识别中（可能需要 10-30 秒）...' : '生成字幕'}
				</ActionButton>

				{error && <ErrorBox message={error} />}
				{result && <ResultBox json={result} />}
			</div>
		</SectionCard>
	);
}

// ==================== Overlay Section ====================

function OverlaySection() {
	const [projectJson, setProjectJson] = useState('');
	const [video, setVideo] = useState<VideoEntry>(emptyVideo());
	const [startMs, setStartMs] = useState('0');
	const [scale, setScale] = useState('0.8');
	const [left, setLeft] = useState('');
	const [top, setTop] = useState('');
	const [width, setWidth] = useState('');
	const [height, setHeight] = useState('');
	const [muted, setMuted] = useState(true);
	const [decibelAdjustment, setDecibelAdjustment] = useState('0');
	const [durationMs, setDurationMs] = useState('');
	const [sourceStartMs, setSourceStartMs] = useState('0');
	const [borderRadius, setBorderRadius] = useState('0');
	const [fadeInMs, setFadeInMs] = useState('0');
	const [fadeOutMs, setFadeOutMs] = useState('0');
	const [result, setResult] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const updateVideoField = useCallback(
		(_idx: number, field: keyof VideoEntry, value: string | boolean) => {
			setVideo((prev) => ({...prev, [field]: value}));
		},
		[],
	);

	const handleUploadComplete = useCallback(
		(_idx: number, data: Partial<VideoEntry>) => {
			setVideo((prev) => ({...prev, ...data}));
		},
		[],
	);

	const probeOverlay = useCallback(async () => {
		if (!video.remoteUrl) return;
		setVideo((prev) => ({...prev, probing: true}));
		try {
			const json = await probeUrl(video.remoteUrl);
			if (json.type === 'success') {
				setVideo((prev) => ({
					...prev,
					durationInSeconds: String(json.durationInSeconds),
					width: String(json.width),
					height: String(json.height),
					hasAudioTrack: json.hasAudioTrack,
					mimeType: json.mimeType || prev.mimeType,
					size: json.size ? String(json.size) : prev.size,
					filename: json.name || prev.filename,
					probed: true,
					probing: false,
				}));
			} else {
				setVideo((prev) => ({...prev, probing: false}));
			}
		} catch {
			setVideo((prev) => ({...prev, probing: false}));
		}
	}, [video.remoteUrl]);

	const submit = useCallback(async () => {
		setLoading(true);
		setError(null);
		setResult(null);
		try {
			if (!video.remoteUrl.trim())
				throw new Error('请提供叠加视频 URL 或上传本地文件');

			const body: Record<string, unknown> = {
				videoUrl: video.remoteUrl,
				startMs: Number(startMs),
				scale: Number(scale),
				muted,
			};
			addNumberIfPresent(body, 'left', left);
			addNumberIfPresent(body, 'top', top);
			addNumberIfPresent(body, 'width', width);
			addNumberIfPresent(body, 'height', height);
			addNumberIfPresent(body, 'decibelAdjustment', decibelAdjustment);
			addNumberIfPresent(body, 'durationMs', durationMs);
			addNumberIfPresent(body, 'sourceStartMs', sourceStartMs);
			addNumberIfPresent(body, 'borderRadius', borderRadius);
			addNumberIfPresent(body, 'fadeInMs', fadeInMs);
			addNumberIfPresent(body, 'fadeOutMs', fadeOutMs);

			if (projectJson.trim()) {
				body.project = parseProjectPayload(projectJson);
			}

			const res = await fetch('/api/compose/overlay', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify(body),
			});
			const json = await res.json();
			setResult(JSON.stringify(json, null, 2));
			if (json.type === 'error') setError(json.error);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Request failed');
		} finally {
			setLoading(false);
		}
	}, [
		borderRadius,
		decibelAdjustment,
		durationMs,
		fadeInMs,
		fadeOutMs,
		height,
		left,
		muted,
		projectJson,
		scale,
		sourceStartMs,
		startMs,
		top,
		video.remoteUrl,
		width,
	]);

	return (
		<SectionCard title="视频叠加 — POST /api/compose/overlay">
			<div className="flex flex-col gap-4">
				<TextareaField
					label="底层工程 JSON（可选，不传则以叠加视频本身新建工程）"
					value={projectJson}
					onChange={setProjectJson}
					rows={4}
					placeholder="粘贴拼接 / 字幕 API 返回的结果或完整工程 JSON..."
				/>

				<VideoUrlCard
					index={0}
					video={video}
					onChange={updateVideoField}
					onProbe={probeOverlay}
					onUploadComplete={handleUploadComplete}
					showAdvanced={false}
					label="叠加视频"
				/>

				<div className="flex gap-4">
					<div className="flex-1">
						<label className="mb-1 block text-xs font-medium text-gray-600">
							开始时间（毫秒）
						</label>
						<input
							type="number"
							min="0"
							step="100"
							value={startMs}
							onChange={(e) => setStartMs(e.target.value)}
							className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 font-mono text-[13px] text-gray-900 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
						/>
					</div>
					<div className="flex-1">
						<label className="mb-1 block text-xs font-medium text-gray-600">
							缩放比例（0-1，默认 0.8 = 80%）
						</label>
						<input
							type="number"
							min="0.1"
							max="1"
							step="0.05"
							value={scale}
							onChange={(e) => setScale(e.target.value)}
							className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 font-mono text-[13px] text-gray-900 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
						/>
					</div>
				</div>
				<p className="-mt-2 text-xs text-gray-400">
					不填位置和尺寸时，叠加视频将居中放置，尺寸为画布的{' '}
					{Math.round(Number(scale) * 100)}%
				</p>

				<div className="grid grid-cols-2 gap-3">
					<InputField label="left（可选）" value={left} onChange={setLeft} />
					<InputField label="top（可选）" value={top} onChange={setTop} />
					<InputField
						label="width（可选，需同时填 height）"
						value={width}
						onChange={setWidth}
					/>
					<InputField
						label="height（可选，需同时填 width）"
						value={height}
						onChange={setHeight}
					/>
					<InputField
						label="素材起点 sourceStartMs"
						value={sourceStartMs}
						onChange={setSourceStartMs}
					/>
					<InputField
						label="持续时间 durationMs（可选）"
						value={durationMs}
						onChange={setDurationMs}
					/>
					<InputField
						label="音量 dB"
						value={decibelAdjustment}
						onChange={setDecibelAdjustment}
					/>
					<InputField
						label="圆角 borderRadius"
						value={borderRadius}
						onChange={setBorderRadius}
					/>
					<InputField
						label="淡入 fadeInMs"
						value={fadeInMs}
						onChange={setFadeInMs}
					/>
					<InputField
						label="淡出 fadeOutMs"
						value={fadeOutMs}
						onChange={setFadeOutMs}
					/>
				</div>
				<label className="flex items-center gap-2 text-sm text-gray-700">
					<input
						type="checkbox"
						checked={muted}
						onChange={(e) => setMuted(e.target.checked)}
					/>
					叠加视频静音（默认开启）
				</label>

				<ActionButton onClick={submit} loading={loading}>
					{loading ? '处理中...' : '添加叠加视频'}
				</ActionButton>

				{error && <ErrorBox message={error} />}
				{result && <ResultBox json={result} />}
			</div>
		</SectionCard>
	);
}

// ==================== Project Validate Section ====================

function ProjectValidateSection() {
	const [projectJson, setProjectJson] = useState('');
	const [result, setResult] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = useCallback(async () => {
		setLoading(true);
		setError(null);
		setResult(null);
		try {
			if (!projectJson.trim()) throw new Error('请粘贴工程 JSON');
			const res = await fetch('/api/compose/project/validate', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({project: parseProjectPayload(projectJson)}),
			});
			const json = await res.json();
			setResult(JSON.stringify(json, null, 2));
			if (json.type === 'error') setError(json.error);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Request failed');
		} finally {
			setLoading(false);
		}
	}, [projectJson]);

	return (
		<SectionCard title="工程校验 — POST /api/compose/project/validate">
			<div className="flex flex-col gap-4">
				<TextareaField
					label="工程 JSON"
					value={projectJson}
					onChange={setProjectJson}
					rows={6}
					placeholder="渲染前粘贴 project，检查缺失资源、非法时长、无 remoteUrl 等问题..."
				/>
				<ActionButton onClick={submit} loading={loading}>
					校验工程
				</ActionButton>
				{error && <ErrorBox message={error} />}
				{result && <ResultBox json={result} />}
			</div>
		</SectionCard>
	);
}

// ==================== Render Section ====================

type CostInfo = {displayCost: string; estimatedBillingDurationInMs: number};

type RenderStatus =
	| {phase: 'idle'}
	| {
			phase: 'rendering';
			bucketName: string;
			renderId: string;
			progress: number;
			costs?: CostInfo;
	  }
	| {
			phase: 'done';
			outputFile: string;
			outputName: string;
			outputSizeInBytes: number;
			costs?: CostInfo;
	  }
	| {phase: 'error'; error: string};

function RenderSection() {
	const [projectJson, setProjectJson] = useState('');
	const [status, setStatus] = useState<RenderStatus>({phase: 'idle'});

	const pollProgress = useCallback(
		async (bucketName: string, renderId: string) => {
			const poll = async () => {
				try {
					const res = await fetch('/api/progress', {
						method: 'POST',
						headers: {'Content-Type': 'application/json'},
						body: JSON.stringify({bucketName, renderId}),
					});
					const json = await res.json();

					const costInfo: CostInfo | undefined = json.costs
						? {
								displayCost: json.costs.displayCost,
								estimatedBillingDurationInMs:
									json.costs.estimatedBillingDurationInMs,
							}
						: undefined;

					if (json.type === 'done') {
						setStatus({
							phase: 'done',
							outputFile: json.outputFile,
							outputName: json.outputName,
							outputSizeInBytes: json.outputSizeInBytes,
							costs: costInfo,
						});
						return;
					}
					if (json.type === 'error') {
						setStatus({phase: 'error', error: json.error});
						return;
					}
					setStatus((prev) =>
						prev.phase === 'rendering'
							? {...prev, progress: json.overallProgress, costs: costInfo}
							: prev,
					);
					setTimeout(poll, 1500);
				} catch (err) {
					setStatus({
						phase: 'error',
						error: err instanceof Error ? err.message : 'Poll failed',
					});
				}
			};
			poll();
		},
		[],
	);

	const submit = useCallback(async () => {
		if (!projectJson.trim()) {
			alert('请先粘贴工程 JSON');
			return;
		}
		let parsed: Record<string, unknown>;
		try {
			const raw = JSON.parse(projectJson);
			parsed = raw.project ?? raw;
		} catch {
			alert('JSON 格式错误');
			return;
		}

		setStatus({phase: 'rendering', bucketName: '', renderId: '', progress: 0});
		try {
			const body = {
				compositionWidth: parsed.compositionWidth,
				compositionHeight: parsed.compositionHeight,
				tracks: parsed.tracks,
				items: parsed.items,
				assets: parsed.assets,
				codec: 'h264',
			};
			const res = await fetch('/api/render', {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify(body),
			});
			const json = await res.json();
			if (json.type === 'error') {
				setStatus({phase: 'error', error: json.error});
				return;
			}
			setStatus({
				phase: 'rendering',
				bucketName: json.bucketName,
				renderId: json.renderId,
				progress: 0,
			});
			pollProgress(json.bucketName, json.renderId);
		} catch (e) {
			setStatus({
				phase: 'error',
				error: e instanceof Error ? e.message : 'Request failed',
			});
		}
	}, [projectJson, pollProgress]);

	const formatBytes = (bytes: number) => {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	};

	return (
		<SectionCard title="视频渲染 — POST /api/render + /api/progress">
			<div className="flex flex-col gap-4">
				<div>
					<label className="mb-1 block text-xs font-medium text-gray-600">
						工程 JSON（粘贴上方拼接 / 字幕 API 返回的 project 字段）
					</label>
					<textarea
						value={projectJson}
						onChange={(e) => setProjectJson(e.target.value)}
						placeholder={
							'粘贴完整工程 JSON 或 API 返回结果（会自动提取 .project 字段）...'
						}
						rows={8}
						className="w-full resize-y rounded-md border border-gray-300 bg-white px-2.5 py-1.5 font-mono text-[13px] text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
					/>
				</div>

				<div>
					<label className="mb-1 block text-xs font-medium text-gray-600">
						编码格式
					</label>
					<div className="inline-flex rounded-full border border-blue-600 bg-blue-600 px-3 py-1 text-[13px] text-white">
						H.264 (MP4)
					</div>
				</div>

				<button
					onClick={submit}
					disabled={status.phase === 'rendering'}
					className={`self-start rounded-lg border-none px-6 py-2 text-sm font-semibold text-white ${
						status.phase === 'rendering'
							? 'cursor-not-allowed bg-purple-300'
							: 'cursor-pointer bg-purple-600 hover:bg-purple-700'
					}`}
				>
					{status.phase === 'rendering' ? '渲染中...' : '开始渲染'}
				</button>

				{status.phase === 'rendering' && (
					<div className="flex flex-col gap-2">
						<div className="flex items-center gap-3">
							<div className="h-3 flex-1 overflow-hidden rounded-full bg-gray-200">
								<div
									className="h-full rounded-full bg-purple-600 transition-all duration-300"
									style={{width: `${Math.round(status.progress * 100)}%`}}
								/>
							</div>
							<span className="min-w-[48px] text-right text-sm font-medium text-gray-700">
								{Math.round(status.progress * 100)}%
							</span>
						</div>
						<div className="flex gap-3 text-xs text-gray-400">
							{status.renderId && <span>Render ID: {status.renderId}</span>}
							{status.costs && (
								<span>预估费用: {status.costs.displayCost}</span>
							)}
						</div>
					</div>
				)}

				{status.phase === 'done' && (
					<div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
						<p className="mb-2 text-sm font-semibold text-emerald-700">
							渲染完成
						</p>
						<video
							src={status.outputFile}
							controls
							className="my-3 w-[400px] max-w-[640px] rounded-lg bg-black"
						/>
						<p className="mb-1 text-xs text-gray-600">
							文件名: {status.outputName} · 大小:{' '}
							{formatBytes(status.outputSizeInBytes)}
							{status.costs && (
								<>
									{' '}
									· Lambda 费用:{' '}
									<span className="font-semibold text-emerald-700">
										{status.costs.displayCost}
									</span>{' '}
									· 计费时长:{' '}
									{(status.costs.estimatedBillingDurationInMs / 1000).toFixed(
										1,
									)}
									s
								</>
							)}
						</p>
						<a
							href={status.outputFile}
							target="_blank"
							rel="noopener noreferrer"
							className="mt-2 inline-block rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white no-underline hover:bg-emerald-700"
						>
							下载视频
						</a>
					</div>
				)}

				{status.phase === 'error' && (
					<div className="rounded-lg border border-red-200 bg-red-50 p-3 text-[13px] text-red-700">
						渲染失败: {status.error}
					</div>
				)}
			</div>
		</SectionCard>
	);
}

// ==================== Shared Components ====================

function SectionCard({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<div className="rounded-xl border border-gray-300 bg-white p-6 text-gray-900">
			<h2 className="mb-4 text-lg font-semibold">{title}</h2>
			{children}
		</div>
	);
}

function VideoUrlCard({
	index,
	video,
	onChange,
	onProbe,
	onRemove,
	onUploadComplete,
	showAdvanced,
	label,
}: {
	index: number;
	video: VideoEntry;
	onChange: (
		idx: number,
		field: keyof VideoEntry,
		value: string | boolean,
	) => void;
	onProbe: (idx: number) => void;
	onRemove?: (idx: number) => void;
	onUploadComplete?: (idx: number, data: Partial<VideoEntry>) => void;
	showAdvanced: boolean;
	label?: string;
}) {
	const fileInputRef = React.useRef<HTMLInputElement>(null);

	const handleFileSelect = useCallback(
		async (e: React.ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			if (!file) return;
			if (e.target) e.target.value = '';

			onChange(index, 'uploading', true as unknown as string);
			onChange(index, 'uploadProgress', '上传中...');
			onChange(index, 'filename', file.name);
			onChange(index, 'size', String(file.size));
			onChange(index, 'mimeType', file.type);

			try {
				const {readUrl, fileKey} = await uploadFileToS3(file);
				onChange(index, 'remoteUrl', readUrl);
				onChange(index, 'remoteFileKey', fileKey);
				onChange(index, 'uploadProgress', '探测中...');

				const probed = await probeUrl(readUrl);
				const result: Partial<VideoEntry> = {
					remoteUrl: readUrl,
					remoteFileKey: fileKey,
					filename: file.name,
					size: String(file.size),
					mimeType: file.type,
					uploading: false,
					uploadProgress: '',
				};
				if (probed.type === 'success') {
					result.durationInSeconds = String(probed.durationInSeconds);
					result.width = String(probed.width);
					result.height = String(probed.height);
					result.hasAudioTrack = probed.hasAudioTrack;
					result.probed = true;
				}
				if (onUploadComplete) {
					onUploadComplete(index, result);
				}
			} catch (err) {
				onChange(index, 'uploading', false as unknown as string);
				onChange(index, 'uploadProgress', '');
				alert(
					'上传失败: ' + (err instanceof Error ? err.message : 'Unknown error'),
				);
			}
		},
		[index, onChange, onUploadComplete],
	);

	const busy = video.probing || video.uploading;

	return (
		<div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-gray-900">
			<div className="mb-2 flex items-center justify-between">
				<span className="text-sm font-semibold">
					{label ?? `视频 #${index + 1}`}
				</span>
				{onRemove && (
					<button
						onClick={() => onRemove(index)}
						className="cursor-pointer border-none bg-transparent p-0 text-[13px] font-medium text-red-500 hover:text-red-700"
					>
						删除
					</button>
				)}
			</div>

			<div className="flex items-end gap-2">
				<div className="min-w-0 flex-1">
					<InputField
						label="视频 URL"
						value={video.remoteUrl}
						onChange={(v) => onChange(index, 'remoteUrl', v)}
						placeholder="https://example.com/video.mp4"
					/>
				</div>
				<button
					onClick={() => onProbe(index)}
					disabled={!video.remoteUrl || busy}
					className={`h-8 rounded-md border-none bg-emerald-600 px-4 py-1.5 text-[13px] font-medium whitespace-nowrap text-white ${
						!video.remoteUrl || busy
							? 'cursor-not-allowed opacity-50'
							: 'cursor-pointer hover:bg-emerald-700'
					}`}
				>
					{video.probing ? '探测中...' : '探测'}
				</button>
			</div>

			<div className="mt-2 flex items-center gap-2.5">
				<input
					ref={fileInputRef}
					type="file"
					accept="video/*"
					onChange={handleFileSelect}
					className="hidden"
				/>
				<button
					onClick={() => fileInputRef.current?.click()}
					disabled={busy}
					className={`rounded-md border border-dashed border-blue-300 bg-blue-50 px-4 py-1.5 text-[13px] font-medium whitespace-nowrap text-blue-600 ${
						busy
							? 'cursor-not-allowed opacity-60'
							: 'cursor-pointer hover:bg-blue-100'
					}`}
				>
					{video.uploading ? video.uploadProgress : '选择本地文件上传'}
				</button>
				{!video.remoteUrl && !video.uploading && (
					<span className="text-xs text-gray-400">
						选择文件后自动上传到 S3 并探测
					</span>
				)}
			</div>

			{video.probed && (
				<div className="mt-1.5 text-xs font-medium text-emerald-600">
					{video.width}x{video.height} &middot;{' '}
					{Number(video.durationInSeconds).toFixed(1)}s
					{video.hasAudioTrack ? ' · 有音频' : ''} · {video.filename}
				</div>
			)}

			{showAdvanced && (
				<div className="mt-2 grid grid-cols-2 gap-2">
					<InputField
						label="文件名"
						value={video.filename}
						onChange={(v) => onChange(index, 'filename', v)}
						placeholder="自动检测"
					/>
					<InputField
						label="时长 (秒)"
						value={video.durationInSeconds}
						onChange={(v) => onChange(index, 'durationInSeconds', v)}
						placeholder="自动检测"
					/>
					<InputField
						label="宽度"
						value={video.width}
						onChange={(v) => onChange(index, 'width', v)}
						placeholder="自动检测"
					/>
					<InputField
						label="高度"
						value={video.height}
						onChange={(v) => onChange(index, 'height', v)}
						placeholder="自动检测"
					/>
					<InputField
						label="S3 File Key"
						value={video.remoteFileKey}
						onChange={(v) => onChange(index, 'remoteFileKey', v)}
						placeholder="uploads/video.mp4"
					/>
					<InputField
						label="MIME 类型"
						value={video.mimeType}
						onChange={(v) => onChange(index, 'mimeType', v)}
						placeholder="自动检测"
					/>
				</div>
			)}
		</div>
	);
}

function InputField({
	label,
	value,
	onChange,
	placeholder,
	w,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	w?: number;
}) {
	return (
		<div
			className={w ? 'min-w-0' : 'min-w-0 flex-1'}
			style={w ? {width: w} : undefined}
		>
			<label className="mb-1 block text-xs font-medium text-gray-600">
				{label}
			</label>
			<input
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-[13px] text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
			/>
		</div>
	);
}

function TextareaField({
	label,
	value,
	onChange,
	placeholder,
	rows = 4,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	rows?: number;
}) {
	return (
		<div>
			<label className="mb-1 block text-xs font-medium text-gray-600">
				{label}
			</label>
			<textarea
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				rows={rows}
				className="w-full resize-y rounded-md border border-gray-300 bg-white px-2.5 py-1.5 font-mono text-[13px] text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
			/>
		</div>
	);
}

function ActionButton({
	onClick,
	loading,
	children,
}: {
	onClick: () => void;
	loading: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			onClick={onClick}
			disabled={loading}
			className={`self-start rounded-lg border-none px-6 py-2 text-sm font-semibold text-white ${
				loading
					? 'cursor-not-allowed bg-blue-300'
					: 'cursor-pointer bg-blue-600 hover:bg-blue-700'
			}`}
		>
			{loading ? '请求中...' : children}
		</button>
	);
}

function ErrorBox({message}: {message: string}) {
	return (
		<div className="rounded-lg border border-red-200 bg-red-50 p-3 text-[13px] text-red-700">
			{message}
		</div>
	);
}

function ResultBox({json}: {json: string}) {
	const copy = useCallback(() => navigator.clipboard.writeText(json), [json]);
	const download = useCallback(() => {
		const blob = new Blob([json], {type: 'application/json'});
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `compose-result-${Date.now()}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}, [json]);
	const openInEditor = useCallback(() => {
		try {
			const parsed = JSON.parse(json);
			const project = parsed.project || parsed;
			const base64 = btoa(
				unescape(encodeURIComponent(JSON.stringify(project))),
			);
			window.open(`/#state=${base64}`, '_blank');
		} catch {
			alert('无法解析 JSON');
		}
	}, [json]);

	return (
		<div>
			<div className="mb-2 flex items-center gap-2">
				<span className="text-[13px] font-semibold text-gray-900">
					返回结果
				</span>
				<button
					onClick={copy}
					className="cursor-pointer rounded border border-gray-300 bg-gray-100 px-2.5 py-0.5 text-xs text-gray-700 hover:bg-gray-200"
				>
					复制
				</button>
				<button
					onClick={download}
					className="cursor-pointer rounded border border-gray-300 bg-gray-100 px-2.5 py-0.5 text-xs text-gray-700 hover:bg-gray-200"
				>
					下载 JSON
				</button>
				<button
					onClick={openInEditor}
					className="cursor-pointer rounded border border-gray-300 bg-gray-100 px-2.5 py-0.5 text-xs text-gray-700 hover:bg-gray-200"
				>
					在编辑器中打开
				</button>
			</div>
			<pre className="max-h-[500px] overflow-auto rounded-lg bg-[#1e1e1e] p-4 text-xs leading-relaxed break-all whitespace-pre-wrap text-[#d4d4d4]">
				{json}
			</pre>
		</div>
	);
}
