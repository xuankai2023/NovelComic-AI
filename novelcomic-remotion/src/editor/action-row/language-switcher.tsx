'use client';

import {useLocale, useTranslations} from 'next-intl';
import {useEffect} from 'react';
import {Locale, localeLabels} from '../../i18n/config';
import {usePathname, useRouter} from '../../i18n/navigation';
import {
	clearStateFromLocaleSwitch,
	saveStateForLocaleSwitch,
} from '../state/locale-switch-state';
import {clsx} from '../utils/clsx';
import {useFullState} from '../utils/use-context';

const languageOptions: Array<{locale: Locale; labelKey: 'zhCN' | 'enUS'}> = [
	{locale: 'zh-CN', labelKey: 'zhCN'},
	{locale: 'en-US', labelKey: 'enUS'},
];

export const LanguageSwitcher: React.FC = () => {
	const locale = useLocale() as Locale;
	const pathname = usePathname();
	const router = useRouter();
	const state = useFullState();
	const t = useTranslations('common.language');

	useEffect(() => {
		clearStateFromLocaleSwitch();
	}, [locale]);

	const switchLocale = (nextLocale: Locale) => {
		if (nextLocale === locale) {
			return;
		}

		saveStateForLocaleSwitch(state);
		router.replace(pathname, {locale: nextLocale});
	};

	return (
		<div
			role="group"
			aria-label={t('label')}
			className="border-editor-starter-surface-separator bg-editor-starter-inset flex h-9 items-center overflow-hidden rounded-lg border shadow-[inset_0_1px_0_var(--color-editor-starter-surface-hover)]"
		>
			{languageOptions.map((option) => {
				const isActive = option.locale === locale;

				return (
					<button
						key={option.locale}
						type="button"
						aria-label={localeLabels[option.locale]}
						aria-pressed={isActive}
						title={localeLabels[option.locale]}
						onClick={() => switchLocale(option.locale)}
						className={clsx(
							'editor-starter-focus-ring h-full min-w-14 px-3 text-xs font-semibold transition-colors',
							isActive
								? 'bg-editor-starter-accent text-editor-starter-on-accent'
								: 'text-editor-starter-text-muted hover:bg-editor-starter-surface-hover hover:text-editor-starter-text',
						)}
					>
						{t(option.labelKey)}
					</button>
				);
			})}
		</div>
	);
};
