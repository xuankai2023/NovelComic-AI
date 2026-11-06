'use client';

import {useEffect} from 'react';
import {Locale} from './config';

export const HtmlLangSync: React.FC<{locale: Locale}> = ({locale}) => {
	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	return null;
};
