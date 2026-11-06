import {hasLocale, NextIntlClientProvider} from 'next-intl';
import {notFound} from 'next/navigation';
import {Locale} from '../../src/i18n/config';
import {HtmlLangSync} from '../../src/i18n/html-lang-sync';
import {loadMessages} from '../../src/i18n/messages';
import {routing} from '../../src/i18n/routing';

export function generateStaticParams() {
	return routing.locales.map((locale) => ({locale}));
}

export default async function LocaleLayout({
	children,
	params,
}: Readonly<{
	children: React.ReactNode;
	params: Promise<{locale: string}>;
}>) {
	const {locale} = await params;

	if (!hasLocale(routing.locales, locale)) {
		notFound();
	}

	const typedLocale = locale as Locale;
	const messages = await loadMessages(typedLocale);

	return (
		<NextIntlClientProvider locale={typedLocale} messages={messages}>
			<HtmlLangSync locale={typedLocale} />
			{children}
		</NextIntlClientProvider>
	);
}
