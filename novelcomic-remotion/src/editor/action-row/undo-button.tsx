import {useCallback} from 'react';
import {useTranslations} from 'next-intl';
import {UndoIcon} from '../icons/undo';
import {clsx} from '../utils/clsx';
import {useCanUseUndoStack, useWriteContext} from '../utils/use-context';
import {actionToolbarButtonClass} from './toolbar-styles';

export const UndoButton = () => {
	const t = useTranslations('editor.actionRow.history');
	const {undo} = useWriteContext();
	const {canUndo} = useCanUseUndoStack();

	const handleUndo = useCallback(() => {
		undo();
	}, [undo]);

	return (
		<button
			className={clsx(actionToolbarButtonClass, !canUndo && 'opacity-50')}
			title={t('undo')}
			onClick={handleUndo}
			disabled={!canUndo}
			aria-label={t('undo')}
		>
			<UndoIcon />
		</button>
	);
};
