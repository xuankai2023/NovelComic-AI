import React, {useEffect} from 'react';
import {useTranslations} from 'next-intl';
import {toast} from 'sonner';
import {FEATURE_SAVE_SHORTCUT} from '../flags';
import {useProjectContext} from '../project/project-context';

export const SaveShortcut: React.FC = () => {
	const t = useTranslations('editor.actionRow.project.save');
	const {saveNow, saveError} = useProjectContext();

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Save: Cmd+S (Mac) or Ctrl+S (Windows/Linux)
			if ((e.metaKey || e.ctrlKey) && e.key === 's' && FEATURE_SAVE_SHORTCUT) {
				e.preventDefault();

				void saveNow('manual').then((saved) => {
					if (!saved) toast.error(saveError ?? t('errorUnknown'));
				});
			}
		};

		window.addEventListener('keydown', handleKeyDown);

		return () => {
			window.removeEventListener('keydown', handleKeyDown);
		};
	}, [saveError, saveNow, t]);

	return null;
};
