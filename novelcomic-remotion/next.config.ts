import type {NextConfig} from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import path from 'path';
import {fileURLToPath} from 'url';

const configDirectory = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
	allowedDevOrigins: ['192.168.0.101'],
	eslint: {
		ignoreDuringBuilds: true,
	},
	outputFileTracingRoot: configDirectory,
	serverExternalPackages: [
		'@remotion/lambda',
		'@remotion/renderer',
		'@remotion/bundler',
		'openai',
	],
};

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

export default withNextIntl(nextConfig);
