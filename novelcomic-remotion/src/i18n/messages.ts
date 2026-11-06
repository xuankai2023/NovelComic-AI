import {Locale} from './config';

type Messages = Record<string, unknown>;

const messageLoaders = {
	'zh-CN': [
		() => import('../../messages/zh-CN/common.json'),
		() => import('../../messages/zh-CN/editor.action-row.json'),
		() => import('../../messages/zh-CN/editor.canvas.json'),
		() => import('../../messages/zh-CN/editor.inspector.json'),
		() => import('../../messages/zh-CN/editor.playback.json'),
		() => import('../../messages/zh-CN/editor.tasks.json'),
		() => import('../../messages/zh-CN/editor.feedback.json'),
	],
	'en-US': [
		() => import('../../messages/en-US/common.json'),
		() => import('../../messages/en-US/editor.action-row.json'),
		() => import('../../messages/en-US/editor.canvas.json'),
		() => import('../../messages/en-US/editor.inspector.json'),
		() => import('../../messages/en-US/editor.playback.json'),
		() => import('../../messages/en-US/editor.tasks.json'),
		() => import('../../messages/en-US/editor.feedback.json'),
	],
} satisfies Record<Locale, Array<() => Promise<{default: Messages}>>>;

const isObject = (value: unknown): value is Messages => {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const deepMerge = (target: Messages, source: Messages): Messages => {
	for (const [key, value] of Object.entries(source)) {
		const currentValue = target[key];
		if (isObject(currentValue) && isObject(value)) {
			target[key] = deepMerge({...currentValue}, value);
			continue;
		}

		target[key] = value;
	}

	return target;
};

export const loadMessages = async (locale: Locale): Promise<Messages> => {
	const files = await Promise.all(messageLoaders[locale].map((load) => load()));

	return files.reduce<Messages>((messages, file) => {
		return deepMerge(messages, file.default);
	}, {});
};
