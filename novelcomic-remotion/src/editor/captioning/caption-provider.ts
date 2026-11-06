export type CaptionProvider = 'openai' | 'elevenlabs';

export const DEFAULT_CAPTION_PROVIDER: CaptionProvider = 'elevenlabs';

export const parseCaptionProvider = (provider: unknown): CaptionProvider => {
	if (provider === undefined || provider === null || provider === '') {
		return DEFAULT_CAPTION_PROVIDER;
	}

	if (provider === 'openai' || provider === 'elevenlabs') {
		return provider;
	}

	throw new Error('Invalid caption provider. Use "openai" or "elevenlabs".');
};
