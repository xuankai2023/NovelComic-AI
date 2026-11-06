import {hasLocale} from 'next-intl';
import {getRequestConfig} from 'next-intl/server';
import {defaultLocale} from './config';
import {loadMessages} from './messages';
import {routing} from './routing';

export default getRequestConfig(async ({requestLocale}) => {
	const requestedLocale = await requestLocale;
	const locale = hasLocale(routing.locales, requestedLocale)
		? requestedLocale
		: defaultLocale;

	return {
		locale,
		messages: await loadMessages(locale),
	};
});
