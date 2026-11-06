'use client';

import {Moon, Sun} from 'lucide-react';
import {useTranslations} from 'next-intl';
import {useTheme} from '../../theme/theme-provider';
import type {ThemeMode} from '../../theme/types';

const themeOptions: Array<{
	mode: ThemeMode;
	Icon: React.ComponentType<{className?: string}>;
}> = [
	{mode: 'light', Icon: Sun},
	{mode: 'dark', Icon: Moon},
];

export const ThemeSwitcher: React.FC = () => {
	const {mode, setMode} = useTheme();
	const t = useTranslations('editor.actionRow.theme');

	return (
		<div
			role="group"
			aria-label={t('label')}
			className="border-editor-starter-surface-separator bg-editor-starter-inset flex items-center overflow-hidden rounded-lg border"
		>
			{themeOptions.map(({mode: optionMode, Icon}) => {
				const isActive = mode === optionMode;

				return (
					<button
						key={optionMode}
						type="button"
						aria-label={t(optionMode)}
						aria-pressed={isActive}
						title={t(optionMode)}
						onClick={() => setMode(optionMode)}
						className="editor-starter-focus-ring text-editor-starter-text-muted hover:bg-editor-starter-surface-hover hover:text-editor-starter-text data-[active=true]:bg-editor-starter-surface-active data-[active=true]:text-editor-starter-text flex h-9 w-9 items-center justify-center transition-colors"
						data-active={isActive}
					>
						<Icon className="size-4" />
					</button>
				);
			})}
		</div>
	);
};
