import {DEFAULT_THEME_MODE, THEME_STORAGE_KEY} from './storage';

const themeBootstrapScript = `
(() => {
	try {
		const storedMode = window.localStorage.getItem('${THEME_STORAGE_KEY}');
		const mode =
			storedMode === 'light' || storedMode === 'dark'
				? storedMode
				: '${DEFAULT_THEME_MODE}';
		document.documentElement.dataset.theme = mode;
		document.documentElement.style.colorScheme = mode;
	} catch {
		document.documentElement.dataset.theme = 'dark';
		document.documentElement.style.colorScheme = 'dark';
	}
})();
`;

export const ThemeBootstrapScript = () => {
	return (
		<script
			id="theme-bootstrap"
			dangerouslySetInnerHTML={{__html: themeBootstrapScript}}
		/>
	);
};
