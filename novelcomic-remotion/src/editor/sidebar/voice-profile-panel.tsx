'use client';

import {
	Check,
	LoaderCircle,
	Mic2,
	Play,
	Plus,
	Power,
	Save,
	Trash2,
	X,
} from 'lucide-react';
import {useTranslations} from 'next-intl';
import React, {useMemo, useRef, useState} from 'react';
import {toast} from 'sonner';
import type {VoiceProfile, VoiceProfileProvider} from '../comic/types';
import {removeVoiceProfile, upsertVoiceProfile} from '../comic/voice-profiles';
import {postCompose} from '../compose/client';
import type {EditorState} from '../state/types';
import {useFullState, useWriteContext} from '../utils/use-context';

const providers: VoiceProfileProvider[] = [
	'manual',
	'elevenlabs',
	'openai',
	'custom',
];

const emptyDraft = {
	id: '',
	characterId: '',
	displayName: '',
	provider: 'manual' as VoiceProfileProvider,
	voiceId: '',
	style: '',
	language: '',
	defaultForCharacter: false,
	enabled: true,
};

type Draft = typeof emptyDraft;

export const VoiceProfilePanel: React.FC<{onClose: () => void}> = ({
	onClose,
}) => {
	const t = useTranslations('editor.actionRow.voiceProfiles');
	const state = useFullState();
	const {setState} = useWriteContext();
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const [draft, setDraft] = useState<Draft>(emptyDraft);
	const [previewText, setPreviewText] = useState('');
	const [previewing, setPreviewing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const profiles = useMemo(
		() =>
			Object.values(state.undoableState.voiceProfiles ?? {}).sort(
				(left, right) =>
					(left.characterId + left.id).localeCompare(
						right.characterId + right.id,
					),
			),
		[state.undoableState.voiceProfiles],
	);

	const reset = () => {
		setDraft(emptyDraft);
		setError(null);
	};

	const edit = (profile: VoiceProfile) => {
		setDraft({
			id: profile.id,
			characterId: profile.characterId,
			displayName: profile.displayName ?? '',
			provider: profile.provider,
			voiceId: profile.voiceId,
			style: profile.style ?? '',
			language: profile.language ?? '',
			defaultForCharacter: profile.defaultForCharacter ?? false,
			enabled: profile.enabled !== false,
		});
		setError(null);
	};

	const save = () => {
		if (!draft.characterId.trim() || !draft.voiceId.trim()) {
			setError(t('required'));
			return;
		}

		const profile: VoiceProfile = {
			id:
				draft.id.trim() ||
				`voice:${draft.characterId.trim()}:${draft.voiceId.trim()}`,
			characterId: draft.characterId.trim(),
			displayName: draft.displayName.trim() || undefined,
			provider: draft.provider,
			voiceId: draft.voiceId.trim(),
			style: draft.style.trim() || undefined,
			language: draft.language.trim() || undefined,
			defaultForCharacter: draft.defaultForCharacter,
			enabled: draft.enabled,
		};

		try {
			setState({
				update: (current: EditorState) => ({
					...current,
					undoableState: upsertVoiceProfile(current.undoableState, profile),
				}),
				commitToUndoStack: true,
				command: {type: 'dialogue.update'},
			});
			toast.success(t('saved'));
			edit(profile);
		} catch (saveError) {
			setError(
				saveError instanceof Error ? saveError.message : t('saveFailed'),
			);
		}
	};

	const remove = (profileId: string) => {
		setState({
			update: (current: EditorState) => ({
				...current,
				undoableState: removeVoiceProfile(current.undoableState, profileId),
			}),
			commitToUndoStack: true,
			command: {type: 'dialogue.update'},
		});
		if (draft.id === profileId) reset();
		toast.success(t('deleted'));
	};

	const toggleEnabled = (profile: VoiceProfile) => {
		setState({
			update: (current: EditorState) => ({
				...current,
				undoableState: upsertVoiceProfile(current.undoableState, {
					...profile,
					enabled: profile.enabled === false,
				}),
			}),
			commitToUndoStack: true,
			command: {type: 'dialogue.update'},
		});
	};

	const preview = async () => {
		if (!draft.characterId.trim() || !draft.voiceId.trim()) {
			setError(t('required'));
			return;
		}
		if (!previewText.trim()) {
			setError(t('previewTextRequired'));
			return;
		}

		setPreviewing(true);
		setError(null);
		try {
			const response = await postCompose<{audioUrl: string}>(
				'/api/compose/voice-profile/preview',
				{
					text: previewText.trim(),
					profile: {
						id: draft.id || 'preview',
						characterId: draft.characterId.trim(),
						provider: draft.provider,
						voiceId: draft.voiceId.trim(),
						...(draft.style.trim() ? {style: draft.style.trim()} : {}),
						...(draft.language.trim() ? {language: draft.language.trim()} : {}),
					},
				},
			);
			const audio = audioRef.current;
			if (!audio) return;
			audio.src = response.audioUrl;
			await audio.play();
		} catch (previewError) {
			const message =
				previewError instanceof Error
					? previewError.message
					: t('previewFailed');
			setError(message);
			toast.error(t('previewFailed'), {description: message});
		} finally {
			setPreviewing(false);
		}
	};

	const field = (
		key: keyof Draft,
		label: string,
		type: 'text' | 'url' = 'text',
	) => (
		<label className="flex min-w-0 flex-col gap-1 text-[10px] text-white/50">
			<span>{label}</span>
			<input
				type={type}
				value={String(draft[key])}
				onChange={(event) =>
					setDraft((current) => ({
						...current,
						[key]: event.target.value,
					}))
				}
				className="h-8 rounded border border-white/10 bg-black/20 px-2 text-xs text-white outline-none focus:border-white/30"
			/>
		</label>
	);

	return (
		<div className="border-editor-starter-surface-separator bg-editor-starter-panel text-editor-starter-text pointer-events-auto absolute top-3 bottom-3 left-[66px] z-50 flex w-[390px] flex-col overflow-hidden rounded-[10px] border shadow-[0_24px_70px_var(--color-editor-starter-popover-shadow)]">
			<div className="flex shrink-0 items-center justify-between border-b border-white/5 px-3 py-2.5">
				<div className="flex items-center gap-2 text-sm font-semibold">
					<Mic2 className="size-4" />
					<span>{t('title')}</span>
				</div>
				<button
					type="button"
					className="flex size-7 items-center justify-center rounded text-white/55 hover:bg-white/10 hover:text-white"
					onClick={onClose}
					title={t('close')}
					aria-label={t('close')}
				>
					<X className="size-4" />
				</button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-3">
				<div className="space-y-2">
					{profiles.map((profile) => (
						<div
							key={profile.id}
							className="flex items-center gap-2 border border-white/8 bg-black/10 p-2"
						>
							<div className="min-w-0 flex-1">
								<div className="truncate text-xs font-semibold text-white/90">
									{profile.displayName || profile.voiceId}
								</div>
								<div className="truncate text-[10px] text-white/45">
									{profile.characterId} · {profile.provider} · {profile.voiceId}
								</div>
							</div>
							{profile.defaultForCharacter ? (
								<Check className="size-3.5 text-emerald-300" />
							) : null}
							<button
								type="button"
								className="flex size-7 items-center justify-center rounded text-white/55 hover:bg-white/10 hover:text-white"
								onClick={() => toggleEnabled(profile)}
								title={profile.enabled === false ? t('enable') : t('disable')}
								aria-label={
									profile.enabled === false ? t('enable') : t('disable')
								}
							>
								<Power
									className={`size-3.5 ${
										profile.enabled === false
											? 'text-white/30'
											: 'text-emerald-300'
									}`}
								/>
							</button>
							<button
								type="button"
								className="flex size-7 items-center justify-center rounded text-white/55 hover:bg-white/10 hover:text-white"
								onClick={() => edit(profile)}
								title={t('edit')}
								aria-label={t('edit')}
							>
								<Save className="size-3.5" />
							</button>
							<button
								type="button"
								className="flex size-7 items-center justify-center rounded text-red-200/70 hover:bg-red-500/15 hover:text-red-100"
								onClick={() => remove(profile.id)}
								title={t('delete')}
								aria-label={t('delete')}
							>
								<Trash2 className="size-3.5" />
							</button>
						</div>
					))}
					{profiles.length === 0 ? (
						<div className="border border-dashed border-white/10 p-3 text-center text-[11px] text-white/45">
							{t('empty')}
						</div>
					) : null}
				</div>

				<div className="mt-3 border-t border-white/8 pt-3">
					<div className="mb-2 flex items-center justify-between">
						<span className="text-xs font-semibold text-white/80">
							{draft.id ? t('editTitle') : t('newTitle')}
						</span>
						<button
							type="button"
							className="flex size-7 items-center justify-center rounded text-white/55 hover:bg-white/10 hover:text-white"
							onClick={reset}
							title={t('newTitle')}
							aria-label={t('newTitle')}
						>
							<Plus className="size-4" />
						</button>
					</div>
					<div className="grid grid-cols-2 gap-2">
						{field('id', t('id'))}
						{field('characterId', t('characterId'))}
						{field('displayName', t('displayName'))}
						{field('voiceId', t('voiceId'))}
						{field('style', t('style'))}
						{field('language', t('language'))}
					</div>
					<div className="mt-2 grid grid-cols-2 gap-2">
						<label className="flex min-w-0 flex-col gap-1 text-[10px] text-white/50">
							<span>{t('provider')}</span>
							<select
								value={draft.provider}
								onChange={(event) =>
									setDraft((current) => ({
										...current,
										provider: event.target.value as VoiceProfileProvider,
									}))
								}
								className="h-8 rounded border border-white/10 bg-black/20 px-2 text-xs text-white outline-none"
							>
								{providers.map((provider) => (
									<option key={provider} value={provider}>
										{provider}
									</option>
								))}
							</select>
						</label>
						<label className="flex items-end gap-2 pb-1 text-[10px] text-white/55">
							<input
								type="checkbox"
								checked={draft.defaultForCharacter}
								onChange={(event) =>
									setDraft((current) => ({
										...current,
										defaultForCharacter: event.target.checked,
									}))
								}
							/>
							{t('default')}
						</label>
					</div>
					<label className="mt-2 flex items-center gap-2 text-[10px] text-white/55">
						<input
							type="checkbox"
							checked={draft.enabled}
							onChange={(event) =>
								setDraft((current) => ({
									...current,
									enabled: event.target.checked,
								}))
							}
						/>
						{t('enabled')}
					</label>
					<div className="mt-2 flex gap-2">
						<button
							type="button"
							className="bg-editor-starter-accent flex h-8 flex-1 items-center justify-center gap-1.5 rounded px-2 text-xs font-semibold text-white hover:brightness-110"
							onClick={save}
						>
							<Save className="size-3.5" />
							{t('save')}
						</button>
						<button
							type="button"
							className="flex h-8 items-center justify-center gap-1.5 rounded border border-white/10 px-2 text-xs text-white/70 hover:bg-white/8"
							onClick={reset}
						>
							<Plus className="size-3.5" />
							{t('new')}
						</button>
					</div>
				</div>

				<div className="mt-3 border-t border-white/8 pt-3">
					<div className="text-xs font-semibold text-white/80">
						{t('previewTitle')}
					</div>
					<textarea
						value={previewText}
						onChange={(event) => setPreviewText(event.target.value)}
						placeholder={t('previewPlaceholder')}
						className="mt-2 min-h-16 w-full resize-y rounded border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-white outline-none focus:border-white/30"
					/>
					<button
						type="button"
						className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded border border-white/10 text-xs text-white/75 hover:bg-white/8 disabled:opacity-40"
						disabled={previewing}
						onClick={preview}
					>
						{previewing ? (
							<LoaderCircle className="size-3.5 animate-spin" />
						) : (
							<Play className="size-3.5" />
						)}
						{previewing ? t('previewing') : t('preview')}
					</button>
					<audio ref={audioRef} className="hidden" />
				</div>

				{error ? (
					<div className="mt-3 border border-red-300/15 bg-red-400/8 p-2 text-[11px] leading-5 text-red-100">
						{error}
					</div>
				) : null}
			</div>
		</div>
	);
};
