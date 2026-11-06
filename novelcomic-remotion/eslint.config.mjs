import {makeConfig} from '@remotion/eslint-config-flat';

const conf = makeConfig({
	remotionDir: ['src/remotion/**'],
});

export default [
	{
		ignores: ['.next', '.react-router', 'next-env.d.ts'],
	},
	...conf,
	{
		rules: {
			'react-hooks/exhaustive-deps': 'error',
			'react-hooks/rules-of-hooks': 'error',
			'no-console': 'error',
			'no-shadow': 'error',
		},
	},
];
