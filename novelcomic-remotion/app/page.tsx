import {redirect} from 'next/navigation';
import {defaultLocale} from '../src/i18n/config';

export default function HomePage() {
	redirect(`/${defaultLocale}`);
}
