import {useCallback} from 'react';
import {useTranslations} from 'next-intl';
import {RedoIcon} from '../icons/redo';
import {clsx} from '../utils/clsx';
import {useCanUseUndoStack, useWriteContext} from '../utils/use-context';
import {actionToolbarButtonClass} from './toolbar-styles';

export const RedoButton = () => {
	const t = useTranslations('editor.actionRow.history');
	const {redo} = useWriteContext();
	const {canRedo} = useCanUseUndoStack();

	const handleRedo = useCallback(() => {
		redo();
	}, [redo]);

	return (
		<button
			className={clsx(actionToolbarButtonClass, !canRedo && 'opacity-50')}
			disabled={!canRedo}
			title={t('redo')}
			onClick={handleRedo}
			aria-label={t('redo')}
		>
			<RedoIcon />
		</button>
	);
};
