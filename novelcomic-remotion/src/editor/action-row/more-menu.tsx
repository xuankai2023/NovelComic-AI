import {Popover} from '@heroui/react';
import {
	Check,
	ChevronRight,
	Ellipsis,
	Languages,
	Moon,
	Sun,
} from 'lucide-react';
import {useLocale, useTranslations} from 'next-intl';
import {useState} from 'react';
import {Locale, localeLabels} from '../../i18n/config';
import {usePathname, useRouter} from '../../i18n/navigation';
import {useTheme} from '../../theme/theme-provider';
import type {ThemeMode} from '../../theme/types';
import {
	clearStateFromLocaleSwitch,
	saveStateForLocaleSwitch,
} from '../state/locale-switch-state';
import {clsx} from '../utils/clsx';
import {useFullState} from '../utils/use-context';

type MoreSubmenu = 'language' | 'theme';

const languageOptions: Array<{locale: Locale; labelKey: 'zhCN' | 'enUS'}> = [
	{locale: 'zh-CN', labelKey: 'zhCN'},
	{locale: 'en-US', labelKey: 'enUS'},
];

const themeOptions: Array<{
	mode: ThemeMode;
	Icon: React.ComponentType<{className?: string}>;
}> = [
	{mode: 'light', Icon: Sun},
	{mode: 'dark', Icon: Moon},
];

const menuRowClassName =
	'group flex h-14 w-full items-center gap-3 rounded-[14px] px-3 text-left text-editor-starter-text transition-colors hover:bg-editor-starter-surface-hover';

const submenuItemClassName =
	'group flex h-11 w-full items-center justify-between rounded-[12px] px-3 text-left text-sm font-semibold transition-colors hover:bg-editor-starter-surface-hover';

const menuIconClassName =
	'bg-editor-starter-inset text-editor-starter-text-muted flex size-9 shrink-0 items-center justify-center rounded-[11px] border border-editor-starter-surface-separator transition-colors group-hover:text-editor-starter-text';

export const MoreMenu: React.FC = () => {
	const tToolbar = useTranslations('editor.actionRow.toolbar');
	const tLanguage = useTranslations('common.language');
	const tTheme = useTranslations('editor.actionRow.theme');
	const locale = useLocale() as Locale;
	const pathname = usePathname();
	const router = useRouter();
	const state = useFullState();
	const {mode, setMode} = useTheme();
	const [isOpen, setIsOpen] = useState(false);
	const [activeSubmenu, setActiveSubmenu] = useState<MoreSubmenu>('language');

	const switchLocale = (nextLocale: Locale) => {
		if (nextLocale === locale) {
			setIsOpen(false);
			return;
		}

		saveStateForLocaleSwitch(state);
		router.replace(pathname, {locale: nextLocale});
		setIsOpen(false);
	};

	return (
		<Popover
			isOpen={isOpen}
			onOpenChange={(open) => {
				setIsOpen(open);
				if (open) {
					clearStateFromLocaleSwitch();
					setActiveSubmenu('language');
				}
			}}
		>
			<Popover.Trigger
				aria-label={tToolbar('moreActions')}
				title={tToolbar('moreActions')}
				className="border-editor-starter-surface-separator bg-editor-starter-inset text-editor-starter-text hover:bg-editor-starter-surface-hover focus-visible:border-editor-starter-surface-subtle data-[focus-visible=true]:border-editor-starter-surface-subtle flex h-10 w-10 items-center justify-center rounded-xl border transition-colors outline-none focus-visible:ring-0 focus-visible:outline-none data-[focus-visible=true]:ring-0 data-[focus-visible=true]:outline-none"
			>
				<Ellipsis className="size-5" />
			</Popover.Trigger>
			<Popover.Content
				placement="bottom end"
				offset={10}
				containerPadding={0}
				className="border-editor-starter-surface-separator bg-editor-starter-panel/95 text-editor-starter-text w-[300px] rounded-[18px] border p-2 shadow-[0_22px_70px_var(--color-editor-starter-popover-shadow)] backdrop-blur"
			>
				<Popover.Dialog className="relative outline-none">
					<div className="border-editor-starter-surface-separator bg-editor-starter-panel/95 absolute top-0 right-full mr-3 w-[236px] rounded-[18px] border p-2 shadow-[0_22px_70px_var(--color-editor-starter-popover-shadow)] backdrop-blur">
						<div className="bg-editor-starter-panel/95 absolute top-5 -right-[7px] size-3 rotate-45 border-t border-r border-editor-starter-surface-separator" />
						<div className="relative">
							<div className="text-editor-starter-text-faint px-3 pt-1 pb-2 text-[11px] font-semibold tracking-[0.08em] uppercase">
								{activeSubmenu === 'language'
									? tLanguage('label')
									: tTheme('label')}
							</div>
							<div className="space-y-1">
								{activeSubmenu === 'language'
									? languageOptions.map((option) => {
											const isActive = option.locale === locale;

											return (
												<button
													key={option.locale}
													type="button"
													aria-pressed={isActive}
													className={clsx(
														submenuItemClassName,
														isActive
															? 'bg-editor-starter-surface-active text-editor-starter-text shadow-[inset_0_1px_0_var(--color-editor-starter-surface-hover)]'
															: 'text-editor-starter-text-muted',
													)}
													onClick={() => switchLocale(option.locale)}
												>
													<span>{tLanguage(option.labelKey)}</span>
													{isActive ? (
														<span className="bg-editor-starter-accent text-editor-starter-on-accent flex size-5 items-center justify-center rounded-full">
															<Check className="size-3.5" />
														</span>
													) : null}
												</button>
											);
										})
									: themeOptions.map(({mode: optionMode, Icon}) => {
											const isActive = optionMode === mode;

											return (
												<button
													key={optionMode}
													type="button"
													aria-pressed={isActive}
													className={clsx(
														submenuItemClassName,
														isActive
															? 'bg-editor-starter-surface-active text-editor-starter-text shadow-[inset_0_1px_0_var(--color-editor-starter-surface-hover)]'
															: 'text-editor-starter-text-muted',
													)}
													onClick={() => {
														setMode(optionMode);
														setIsOpen(false);
													}}
												>
													<span className="flex items-center gap-3">
														<Icon className="size-4" />
														{tTheme(optionMode)}
													</span>
													{isActive ? (
														<span className="bg-editor-starter-accent text-editor-starter-on-accent flex size-5 items-center justify-center rounded-full">
															<Check className="size-3.5" />
														</span>
													) : null}
												</button>
											);
										})}
							</div>
						</div>
					</div>
					<div className="space-y-1">
						<button
							type="button"
							className={clsx(
								menuRowClassName,
								activeSubmenu === 'language' &&
									'bg-editor-starter-surface-active',
							)}
							onMouseEnter={() => setActiveSubmenu('language')}
							onFocus={() => setActiveSubmenu('language')}
						>
							<span className={menuIconClassName}>
								<Languages className="size-5" />
							</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sm font-semibold">
									{tLanguage('label')}
								</span>
								<span className="text-editor-starter-text-muted mt-0.5 block truncate text-xs">
									{localeLabels[locale]}
								</span>
							</span>
							<ChevronRight className="text-editor-starter-text-muted group-hover:text-editor-starter-text size-4 shrink-0 transition-colors" />
						</button>
						<button
							type="button"
							className={clsx(
								menuRowClassName,
								activeSubmenu === 'theme' && 'bg-editor-starter-surface-active',
							)}
							onMouseEnter={() => setActiveSubmenu('theme')}
							onFocus={() => setActiveSubmenu('theme')}
						>
							<span className={menuIconClassName}>
								{mode === 'light' ? (
									<Sun className="size-5" />
								) : (
									<Moon className="size-5" />
								)}
							</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sm font-semibold">
									{tTheme('label')}
								</span>
								<span className="text-editor-starter-text-muted mt-0.5 block truncate text-xs">
									{tTheme(mode)}
								</span>
							</span>
							<ChevronRight className="text-editor-starter-text-muted group-hover:text-editor-starter-text size-4 shrink-0 transition-colors" />
						</button>
					</div>
				</Popover.Dialog>
			</Popover.Content>
		</Popover>
	);
};
