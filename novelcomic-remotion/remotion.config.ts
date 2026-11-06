import {Config, WebpackOverrideFn} from '@remotion/cli/config';

Config.setEntryPoint('./src/remotion/index.ts');

export const webpackOverride: WebpackOverrideFn = (config) => {
	return config;
};

Config.overrideWebpackConfig(webpackOverride);
