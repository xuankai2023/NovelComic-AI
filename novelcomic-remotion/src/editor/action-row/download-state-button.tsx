import {Button} from '@heroui/react';
import {useTranslations} from 'next-intl';
import {useCallback} from 'react';
import {toast} from 'sonner';
import {DownloadIcon} from '../icons/download-state';
import {
	cleanUpAssetStatus,
	cleanUpStateBeforeSaving,
} from '../state/clean-up-state-before-saving';
import {clsx} from '../utils/clsx';
import {hasUploadingAssets} from '../utils/upload-status';
import {useFullState} from '../utils/use-context';
import {
	actionPopoverButtonClass,
	actionToolbarButtonClass,
} from './toolbar-styles';

export const DownloadStateButton: React.FC<{
	variant?: 'toolbar' | 'popover';
}> = ({variant = 'toolbar'}) => {
	const t = useTranslations('editor.actionRow.project.download');
	const state = useFullState();

	const handleDownload = useCallback(() => {
		try {
			const cleanedUpState = cleanUpAssetStatus(state);
			const stateToDownload = cleanUpStateBeforeSaving(
				cleanedUpState.undoableState,
			);

			// Create a blob with the state data
			const dataStr = JSON.stringify(stateToDownload, null, 2);
			const dataBlob = new Blob([dataStr], {type: 'application/json'});

			// Create download link
			const url = URL.createObjectURL(dataBlob);
			const link = document.createElement('a');
			link.href = url;
			link.download = `editor-state-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;

			// Trigger download
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);

			// Clean up URL
			URL.revokeObjectURL(url);

			toast.success(t('success'));
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : t('errorFallback'),
			);
		}
	}, [state, t]);

	const assetsUploading = hasUploadingAssets(state.assetStatus);

	if (variant === 'popover') {
		return (
			<Button
				fullWidth
				variant="ghost"
				aria-label={t('ariaLabel')}
				isDisabled={assetsUploading}
				onPress={handleDownload}
				className={clsx(actionPopoverButtonClass, 'h-11')}
			>
				<DownloadIcon />
				<span>{t('button')}</span>
			</Button>
		);
	}

	return (
		<button
			data-uploading={Boolean(assetsUploading)}
			className={clsx(actionToolbarButtonClass, assetsUploading && 'opacity-50')}
			title={
				assetsUploading
					? t('disabledAssetsUploading')
					: t('title')
			}
			disabled={assetsUploading}
			onClick={handleDownload}
			aria-label={t('ariaLabel')}
		>
			<DownloadIcon />
		</button>
	);
};
