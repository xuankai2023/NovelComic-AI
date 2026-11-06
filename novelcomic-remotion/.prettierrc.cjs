/* eslint-disable no-undef */
module.exports = {
	singleQuote: true,
	bracketSpacing: false,
	useTabs: true,
	overrides: [
		{
			files: ['*.yml'],
			options: {
				singleQuote: false,
			},
		},
		{
			files: ['*.md', '*.mdx'],
			options: {
				useTabs: false,
			},
		},
	],
	plugins: [
		require.resolve('prettier-plugin-organize-imports'),
		require.resolve('prettier-plugin-tailwindcss'),
	],
};
