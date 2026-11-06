import React, {
	useCallback,
	useImperativeHandle,
	useMemo,
	useState,
} from 'react';
import {Button} from '@heroui/react';
import {useTranslations} from 'next-intl';
import {toast} from 'sonner';
import {SaveIcon} from '../icons/save';
import {UndoableState} from '../state/types';
import {clsx} from '../utils/clsx';
import {useFullState} from '../utils/use-context';
import {useProjectContext} from '../project/project-context';
import {
	actionPopoverButtonClass,
	actionToolbarButtonClass,
} from './toolbar-styles';

export const saveButtonRef = React.createRef<{
	setLastSavedState: (state: UndoableState) => void;
}>();

export const SaveButton: React.FC<{
	variant?: 'toolbar' | 'popover';
}> = ({variant = 'toolbar'}) => {
	const t = useTranslations('editor.actionRow.project.save');
	const state = useFullState();
	const {activeProject, saveStatus, saveError, saveNow} = useProjectContext();
	const [lastSavedState, setLastSavedState] = useState<UndoableState | null>(
		null,
	);

	const handleSave = useCallback(async () => {
		const saved = await saveNow('manual');
		if (!saved && saveError) toast.error(saveError);
		else if (saved) setLastSavedState(state.undoableState);
	}, [saveError, saveNow, state.undoableState]);

	useImperativeHandle(saveButtonRef, () => ({
		setLastSavedState,
	}));

	const isSavedState = saveStatus === 'saved' || lastSavedState === state.undoableState;
	const isSaving = saveStatus === 'saving';

	const title = useMemo(() => {
		if (!activeProject) return '请先打开工程';
		if (isSaving) return '工程保存中';
		if (saveError) return saveError;
		return t('ariaLabel');
	}, [activeProject, isSaving, saveError, t]);

	const isDisabled = useMemo(() => {
		return !activeProject || isSaving;
	}, [activeProject, isSaving]);

	if (variant === 'popover') {
		return (
			<Button
				fullWidth
				variant="ghost"
				aria-label={t('ariaLabel')}
				isDisabled={isDisabled}
				onPress={handleSave}
				className={clsx(actionPopoverButtonClass, 'h-11')}
			>
				<SaveIcon />
				<span>{t('button')}</span>
				{isSavedState ? <span className="text-xs opacity-60">已保存</span> : null}
			</Button>
		);
	}

	return (
		<button
			data-saved={Boolean(isSavedState)}
			data-saving={Boolean(isSaving)}
			data-save-status={saveStatus}
			className={clsx(
				actionToolbarButtonClass,
				(isSavedState || isSaving) && 'opacity-50',
			)}
			title={title}
			disabled={isDisabled}
			onClick={handleSave}
			aria-label={title}
		>
			<SaveIcon />
		</button>
	);
};
