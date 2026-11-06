import {Hand} from 'lucide-react';
import {useTranslations} from 'next-intl';
import React, {useCallback, useContext} from 'react';
import {EditModeContext} from '../edit-mode';
import {FEATURE_HAND_TOOL} from '../flags';
import {EditModeIcon} from '../icons/edit-mode';

const toolModeSectionClass =
	'flex items-center gap-2 rounded-[18px] border border-editor-starter-surface-separator bg-editor-starter-inset p-1 shadow-[inset_0_1px_0_var(--color-editor-starter-surface-hover)] backdrop-blur-md';

const toolModeButtonClass =
	'editor-starter-focus-ring flex h-10 w-10 items-center justify-center rounded-[14px] text-editor-starter-text transition-colors hover:bg-editor-starter-surface-hover/70 data-[active=true]:bg-editor-starter-surface-hover';

export const ToolSelection: React.FC = () => {
	const t = useTranslations('editor.actionRow.tools');
	const {editMode, setEditMode} = useContext(EditModeContext);

	const setSelectEditMode = useCallback(() => {
		setEditMode('select');
	}, [setEditMode]);

	const setHandEditMode = useCallback(() => {
		setEditMode('hand');
	}, [setEditMode]);

	return (
		<div role="group" aria-label={t('group')} className={toolModeSectionClass}>
			<button
				type="button"
				data-active={editMode === 'select'}
				className={toolModeButtonClass}
				title={t('select')}
				onClick={setSelectEditMode}
				aria-label={t('select')}
			>
				<EditModeIcon
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					className="w-4"
				/>
			</button>

			{FEATURE_HAND_TOOL ? (
				<>
					<button
						type="button"
						onClick={setHandEditMode}
						data-active={editMode === 'hand'}
						className={toolModeButtonClass}
						title={t('hand')}
						aria-label={t('panCanvas')}
					>
						<Hand className="h-4 w-4" />
					</button>
				</>
			) : null}
		</div>
	);
};
