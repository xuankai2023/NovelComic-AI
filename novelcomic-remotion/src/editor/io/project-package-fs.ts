import {mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {ProjectPackageBuildResult} from './project-package';

/** Writes a package beside the live file and renames it only after it is complete. */
export const writeProjectPackageAtomic = async (path: string, packageResult: ProjectPackageBuildResult): Promise<void> => {
	const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	await mkdir(dirname(path), {recursive: true});
	try {
		await writeFile(temporaryPath, packageResult.body, {flag: 'wx'});
		await rename(temporaryPath, path);
	} catch (error) {
		await rm(temporaryPath, {force: true}).catch(() => undefined);
		throw error;
	}
};
