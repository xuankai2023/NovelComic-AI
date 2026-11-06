import {Button} from '@heroui/react';
import {useTranslations} from 'next-intl';
import {useCallback, useRef} from 'react';
import {toast} from 'sonner';
import {UploadIcon} from '../icons/upload';
import {normalizeUndoableState} from '../state/normalize-undoable-state';
import {UndoableState} from '../state/types';
import {clsx} from '../utils/clsx';
import {hasUploadingAssets} from '../utils/upload-status';
import {useFullState} from '../utils/use-context';
import {useProjectContext} from '../project/project-context';
import {
	actionPopoverButtonClass,
	actionToolbarButtonClass,
} from './toolbar-styles';

export const LoadStateButton: React.FC<{
	variant?: 'toolbar' | 'popover';
}> = ({variant = 'toolbar'}) => {
	const t = useTranslations('editor.actionRow.project.load');
	const state = useFullState();
	const {importState} = useProjectContext();
	const fileInputRef = useRef<HTMLInputElement>(null);

	const handleLoadClick = useCallback(() => {
		fileInputRef.current?.click();
	}, []);

	const handleFileChange = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const file = event.target.files?.[0];
			if (!file) {
				return;
			}

			// Validate file type
			if (!file.name.endsWith('.json')) {
				toast.error(t('invalidJson'));
				return;
			}

			const reader = new FileReader();
			reader.onload = (e) => {
				try {
					const result = e.target?.result;
					if (typeof result !== 'string') {
						throw new Error(t('readFailed'));
					}

					const parsed = JSON.parse(result) as UndoableState & {
						project?: UndoableState;
					};
					const loadedState = normalizeUndoableState(
						parsed.project ?? parsed,
					);

					// Basic validation of loaded state structure
					if (
						!loadedState ||
						typeof loadedState !== 'object' ||
						!Array.isArray(loadedState.tracks) ||
						typeof loadedState.items !== 'object' ||
						typeof loadedState.assets !== 'object' ||
						typeof loadedState.fps !== 'number' ||
						typeof loadedState.compositionWidth !== 'number' ||
						typeof loadedState.compositionHeight !== 'number'
					) {
						throw new Error(t('invalidFormat'));
					}

					void importState(loadedState).then((imported) => {
						if (imported) toast.success(t('success'));
						else toast.error(t('errorFallback'));
					});
				} catch (error) {
					toast.error(
						error instanceof Error
							? t('errorWithMessage', {message: error.message})
							: t('errorFallback'),
					);
				}
			};

			reader.onerror = () => {
				toast.error(t('readFailed'));
			};

			reader.readAsText(file);

			// Reset the input so the same file can be selected again
			event.target.value = '';
		},
		[importState, t],
	);

	const assetsUploading = hasUploadingAssets(state.assetStatus);

	return (
		<>
			{variant === 'popover' ? (
				<Button
					fullWidth
					variant="ghost"
					aria-label={t('ariaLabel')}
					isDisabled={assetsUploading}
					onPress={handleLoadClick}
					className={clsx(actionPopoverButtonClass, 'h-11')}
				>
					<UploadIcon />
					<span>{t('button')}</span>
				</Button>
			) : (
				<button
					data-uploading={Boolean(assetsUploading)}
					className={clsx(
						actionToolbarButtonClass,
						assetsUploading && 'opacity-50',
					)}
					title={
						assetsUploading
							? t('disabledAssetsUploading')
							: t('title')
					}
					disabled={assetsUploading}
					onClick={handleLoadClick}
					aria-label={t('ariaLabel')}
				>
					<UploadIcon />
				</button>
			)}
			<input
				ref={fileInputRef}
				type="file"
				accept=".json"
				style={{display: 'none'}}
				onChange={handleFileChange}
			/>
		</>
	);
};
