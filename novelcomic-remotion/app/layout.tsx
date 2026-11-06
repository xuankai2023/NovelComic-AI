import type {Metadata} from 'next';
import {defaultLocale} from '../src/i18n/config';
import {ThemeProvider} from '../src/theme/theme-provider';
import {ThemeBootstrapScript} from '../src/theme/theme-script';
import './globals.css';

export const metadata: Metadata = {
	title: 'OpenCreator Cut',
	icons: {
		icon: '/favicon.ico',
	},
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang={defaultLocale} data-theme="dark" suppressHydrationWarning>
			<head>
				<ThemeBootstrapScript />
			</head>
			<body className="bg-editor-starter-bg text-editor-starter-text">
				<ThemeProvider>
					{children}
				</ThemeProvider>
			</body>
		</html>
	);
}
