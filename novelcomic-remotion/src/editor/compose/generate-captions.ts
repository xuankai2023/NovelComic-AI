import {elevenLabsTranscriptToCaptions} from '@remotion/elevenlabs';
import type {ElevenLabsTranscript} from '@remotion/elevenlabs';
import {
	OpenAiVerboseTranscription,
	openAiWhisperApiToCaptions,
} from '@remotion/openai-whisper';
import type {Caption} from '@remotion/captions';
import OpenAI from 'openai';
import {Converter} from 'opencc-js';
import {
	DEFAULT_CAPTION_PROVIDER,
	type CaptionProvider,
} from '../captioning/caption-provider';
import {getCOSObjectBuffer} from '../utils/cos-client';

export type CaptionLanguage = 'zh' | 'en' | 'auto';

export const DEFAULT_CAPTION_LANGUAGE: CaptionLanguage = 'auto';

export const parseCaptionLanguage = (value: unknown): CaptionLanguage => {
	if (value === 'zh' || value === 'en' || value === 'auto') {
		return value;
	}
	return DEFAULT_CAPTION_LANGUAGE;
};

const formatMs = (ms: number) => `${Math.round(ms)}ms`;
const formatKB = (bytes: number) => `${(bytes / 1024).toFixed(1)}KB`;

// eslint-disable-next-line no-console
const log = (msg: string) => console.log(`[字幕] ${msg}`);

const traditionalToSimplified = Converter({from: 't', to: 'cn'});

/* eslint-disable no-control-regex */
const ZERO_WIDTH_AND_CONTROL =
	/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g;
/* eslint-enable no-control-regex */
const SANITIZE_REGEX = /[^\p{L}\p{N}\s\-_/]/gu;

function sanitizeText(text: string): string {
	const hadLeadingSpace = /^\s/.test(text);
	const cleaned = text
		.replace(ZERO_WIDTH_AND_CONTROL, '')
		.replace(SANITIZE_REGEX, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!cleaned) return '';
	return hadLeadingSpace ? ` ${cleaned}` : cleaned;
}

// 相邻字幕时间间隙超过该值时，认为是新句子起点，给后一条加空格前缀。
// 这样 @remotion/captions 的 createTikTokStyleCaptions 才能正确分页，
// 否则中文逐字字幕会被合并成一整页，整段一次性显示。
const SENTENCE_GAP_MS = 400;

function postProcessCaptions(captions: Caption[]): Caption[] {
	const startedAt = Date.now();
	const cleanedList = captions.flatMap((caption) => {
		const simplified = traditionalToSimplified(caption.text);
		const cleaned = sanitizeText(simplified);
		if (!cleaned.trim()) return [];
		return [{...caption, text: cleaned}];
	});

	let insertedSentenceBreaks = 0;
	const result = cleanedList.map((caption, idx) => {
		if (idx === 0) {
			return {...caption, text: caption.text.replace(/^\s+/, '')};
		}
		const prev = cleanedList[idx - 1];
		const gap = caption.startMs - prev.endMs;
		const alreadyHasLeadingSpace = /^\s/.test(caption.text);
		if (gap >= SENTENCE_GAP_MS && !alreadyHasLeadingSpace) {
			insertedSentenceBreaks++;
			return {...caption, text: ` ${caption.text.replace(/^\s+/, '')}`};
		}
		return caption;
	});

	log(
		`【后处理】繁→简 + 过滤emoji和标点 + 间隙分句 完成 原始=${captions.length} → 清洗后=${result.length} 移除=${captions.length - result.length} 插入分句=${insertedSentenceBreaks} 间隙阈值=${SENTENCE_GAP_MS}ms 耗时=${formatMs(Date.now() - startedAt)}`,
	);
	return result;
}

function mapLanguageToWhisper(lang: CaptionLanguage): string | undefined {
	return lang === 'auto' ? undefined : lang;
}

function mapLanguageToElevenLabs(lang: CaptionLanguage): string | undefined {
	if (lang === 'auto') return undefined;
	return lang === 'zh' ? 'zho' : 'eng';
}

function whisperTranscribe(
	openai: OpenAI,
	file: File,
	language: CaptionLanguage,
): Promise<Caption[]> {
	const whisperLang = mapLanguageToWhisper(language);
	return openai.audio.transcriptions
		.create({
			file,
			model: 'whisper-1',
			response_format: 'verbose_json',
			timestamp_granularities: ['word'],
			...(whisperLang ? {language: whisperLang} : {}),
		})
		.then((transcription) => {
			const {captions} = openAiWhisperApiToCaptions({
				transcription: transcription as OpenAiVerboseTranscription,
			});
			return captions;
		});
}

async function elevenLabsTranscribe({
	file,
	apiKey,
	language,
}: {
	file: File;
	apiKey: string;
	language: CaptionLanguage;
}): Promise<Caption[]> {
	const form = new FormData();
	form.append('file', file);
	form.append('model_id', 'scribe_v2');
	form.append('timestamps_granularity', 'word');

	const elevenLabsLang = mapLanguageToElevenLabs(language);
	if (elevenLabsLang) {
		form.append('language_code', elevenLabsLang);
	}

	const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
		method: 'POST',
		headers: {
			'xi-api-key': apiKey,
		},
		body: form,
	});

	const transcript = await response.json();

	if (!response.ok) {
		throw new Error(
			`ElevenLabs Speech to Text failed: ${
				typeof transcript === 'object' && transcript !== null
					? JSON.stringify(transcript)
					: response.statusText
			}`,
		);
	}

	const {captions} = elevenLabsTranscriptToCaptions({
		transcript: transcript as ElevenLabsTranscript,
	});

	return captions;
}

async function transcribeCaptions({
	file,
	provider,
	openaiApiKey,
	elevenLabsApiKey,
	language,
}: {
	file: File;
	provider: CaptionProvider;
	openaiApiKey?: string;
	elevenLabsApiKey?: string;
	language: CaptionLanguage;
}): Promise<Caption[]> {
	const sttStartedAt = Date.now();
	log(
		`【识别】调用厂商 API 厂商=${provider} 语言=${language} 文件大小=${formatKB(file.size)}`,
	);
	const raw = await (async () => {
		if (provider === 'elevenlabs') {
			if (!elevenLabsApiKey) {
				throw new Error('ELEVENLABS_API_KEY is not configured on the server');
			}

			return elevenLabsTranscribe({
				file,
				apiKey: elevenLabsApiKey,
				language,
			});
		}

		if (!openaiApiKey) {
			throw new Error('OPENAI_API_KEY is not configured on the server');
		}

		const openai = new OpenAI({apiKey: openaiApiKey});
		return whisperTranscribe(openai, file, language);
	})();
	log(
		`【识别】厂商返回 厂商=${provider} 原始字幕条数=${raw.length} 耗时=${formatMs(Date.now() - sttStartedAt)}`,
	);

	return postProcessCaptions(raw);
}

export const generateCaptionsFromCOS = async ({
	fileKey,
	openaiApiKey,
	elevenLabsApiKey,
	provider = DEFAULT_CAPTION_PROVIDER,
	language = DEFAULT_CAPTION_LANGUAGE,
}: {
	fileKey: string;
	openaiApiKey?: string;
	elevenLabsApiKey?: string;
	provider?: CaptionProvider;
	language?: CaptionLanguage;
}): Promise<Caption[]> => {
	const dlStartedAt = Date.now();
	log(`【媒体加载】从 COS 拉取音频 fileKey=${fileKey}`);
	const buffer = await getCOSObjectBuffer(fileKey);
	log(
		`【媒体加载】COS 拉取完成 大小=${formatKB(buffer.length)} 耗时=${formatMs(Date.now() - dlStartedAt)}`,
	);
	const blob = new Blob([new Uint8Array(buffer)], {
		type: 'audio/wav',
	});
	const file = new File([blob], 'audio.wav', {type: 'audio/wav'});

	return transcribeCaptions({
		file,
		provider,
		openaiApiKey,
		elevenLabsApiKey,
		language,
	});
};

export const generateCaptionsFromUrl = async ({
	url,
	openaiApiKey,
	elevenLabsApiKey,
	provider = DEFAULT_CAPTION_PROVIDER,
	language = DEFAULT_CAPTION_LANGUAGE,
}: {
	url: string;
	openaiApiKey?: string;
	elevenLabsApiKey?: string;
	provider?: CaptionProvider;
	language?: CaptionLanguage;
}): Promise<Caption[]> => {
	const dlStartedAt = Date.now();
	log(`【媒体加载】从 URL 拉取媒体 url=${url}`);
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch media from URL: ${response.status}`);
	}

	const arrayBuffer = await response.arrayBuffer();
	const contentType = response.headers.get('content-type') || 'video/mp4';
	log(
		`【媒体加载】URL 拉取完成 大小=${formatKB(arrayBuffer.byteLength)} contentType=${contentType} 耗时=${formatMs(Date.now() - dlStartedAt)}`,
	);
	const ext = contentType.includes('webm')
		? 'webm'
		: contentType.includes('audio')
			? 'wav'
			: 'mp4';
	const blob = new Blob([arrayBuffer], {type: contentType});
	const file = new File([blob], `media.${ext}`, {type: contentType});

	return transcribeCaptions({
		file,
		provider,
		openaiApiKey,
		elevenLabsApiKey,
		language,
	});
};
