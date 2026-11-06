import type {UndoableState} from '../state/types';
import {domainInvariant} from './errors';
import type {VoiceProfile} from './types';

export type VoiceProfileRef = {
	characterId?: string;
	voiceProfileId?: string;
};

export type VoiceProfileMetadata = VoiceProfileRef & {
	voiceProvider?: string;
	voiceId?: string;
	voiceStyle?: string;
};

const isNonEmpty = (value: string | undefined): value is string => {
	return typeof value === 'string' && value.trim().length > 0;
};

const cleanOptional = (value: string | undefined): string | undefined => {
	if (!isNonEmpty(value)) {
		return undefined;
	}

	return value.trim();
};

const cleanProfile = (profile: VoiceProfile): VoiceProfile => {
	if (!isNonEmpty(profile.id)) {
		throw domainInvariant('Voice profile id is required');
	}

	if (!isNonEmpty(profile.characterId)) {
		throw domainInvariant('Voice profile characterId is required');
	}

	if (!isNonEmpty(profile.voiceId)) {
		throw domainInvariant('Voice profile voiceId is required');
	}

	const next: VoiceProfile = {
		id: profile.id.trim(),
		characterId: profile.characterId.trim(),
		provider: profile.provider,
		voiceId: profile.voiceId.trim(),
	};
	const displayName = cleanOptional(profile.displayName);
	if (displayName) {
		next.displayName = displayName;
	}

	const style = cleanOptional(profile.style);
	if (style) {
		next.style = style;
	}

	const language = cleanOptional(profile.language);
	if (language) {
		next.language = language;
	}

	if (profile.defaultForCharacter !== undefined) {
		next.defaultForCharacter = profile.defaultForCharacter;
	}
	if (profile.enabled !== undefined) {
		next.enabled = profile.enabled;
	}

	return next;
};

export const cloneVoiceProfiles = (
	voiceProfiles: UndoableState['voiceProfiles'],
): UndoableState['voiceProfiles'] => {
	if (!voiceProfiles) {
		return undefined;
	}

	return Object.fromEntries(
		Object.entries(voiceProfiles).map(([id, profile]) => {
			return [id, {...profile}];
		}),
	);
};

export const upsertVoiceProfile = (
	project: UndoableState,
	profile: VoiceProfile,
): UndoableState => {
	const next = cleanProfile(profile);
	const existing = project.voiceProfiles ?? {};
	const normalizedProfiles = next.defaultForCharacter
		? Object.fromEntries(
				Object.entries(existing).map(([id, candidate]) => [
					id,
					candidate.characterId === next.characterId && id !== next.id
						? {...candidate, defaultForCharacter: false}
						: candidate,
				]),
			)
		: existing;
	return {
		...project,
		voiceProfiles: {
			...normalizedProfiles,
			[next.id]: next,
		},
	};
};

export const removeVoiceProfile = (
	project: UndoableState,
	profileId: string,
): UndoableState => {
	if (!project.voiceProfiles?.[profileId]) {
		return project;
	}

	const voiceProfiles = {...project.voiceProfiles};
	delete voiceProfiles[profileId];
	return {
		...project,
		voiceProfiles,
	};
};

const findDefaultProfile = (
	profiles: readonly VoiceProfile[],
): VoiceProfile | null => {
	const defaults = profiles.filter((profile) => {
		return profile.defaultForCharacter && profile.enabled !== false;
	});
	if (defaults.length === 1) {
		return defaults[0] ?? null;
	}

	if (profiles.length === 1) {
		return profiles[0] ?? null;
	}

	return null;
};

export const resolveVoiceProfile = (
	project: UndoableState,
	ref: VoiceProfileRef,
): VoiceProfile | null => {
	if (ref.voiceProfileId) {
		const profile = project.voiceProfiles?.[ref.voiceProfileId];
		if (!profile) {
			throw domainInvariant(
				`Voice profile ${ref.voiceProfileId} does not exist`,
			);
		}

		if (ref.characterId && profile.characterId !== ref.characterId) {
			throw domainInvariant(
				`Voice profile ${ref.voiceProfileId} does not belong to character ${ref.characterId}`,
			);
		}

		return profile;
	}

	if (!ref.characterId) {
		return null;
	}

	const matches = Object.values(project.voiceProfiles ?? {}).filter(
		(profile) => {
			return (
				profile.characterId === ref.characterId && profile.enabled !== false
			);
		},
	);
	return findDefaultProfile(matches);
};

export const resolveVoiceProfileMetadata = (
	project: UndoableState,
	ref: VoiceProfileRef,
): VoiceProfileMetadata => {
	const profile = resolveVoiceProfile(project, ref);
	if (!profile) {
		const metadata: VoiceProfileMetadata = {};
		if (ref.characterId) {
			metadata.characterId = ref.characterId;
		}

		if (ref.voiceProfileId) {
			metadata.voiceProfileId = ref.voiceProfileId;
		}

		return metadata;
	}

	return {
		characterId: profile.characterId,
		voiceProfileId: profile.id,
		voiceProvider: profile.provider,
		voiceId: profile.voiceId,
		...(profile.style ? {voiceStyle: profile.style} : {}),
	};
};
