import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const messagesRoot = path.join(root, 'messages');
const locales = ['zh-CN', 'en-US'];

const readJson = (filePath) => {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const flattenKeys = (value, prefix = '') => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return [prefix];
	}

	return Object.entries(value).flatMap(([key, nestedValue]) => {
		const nextPrefix = prefix ? `${prefix}.${key}` : key;
		return flattenKeys(nestedValue, nextPrefix);
	});
};

const listJsonFiles = (locale) => {
	return fs
		.readdirSync(path.join(messagesRoot, locale))
		.filter((file) => file.endsWith('.json'))
		.sort();
};

const [baseLocale, ...otherLocales] = locales;
const baseFiles = listJsonFiles(baseLocale);
const errors = [];

for (const locale of otherLocales) {
	const files = listJsonFiles(locale);
	const missingFiles = baseFiles.filter((file) => !files.includes(file));
	const extraFiles = files.filter((file) => !baseFiles.includes(file));

	for (const file of missingFiles) {
		errors.push(`${locale} is missing file ${file}`);
	}

	for (const file of extraFiles) {
		errors.push(`${locale} has extra file ${file}`);
	}

	for (const file of baseFiles.filter((name) => files.includes(name))) {
		const baseKeys = flattenKeys(readJson(path.join(messagesRoot, baseLocale, file)));
		const localeKeys = flattenKeys(readJson(path.join(messagesRoot, locale, file)));
		const missingKeys = baseKeys.filter((key) => !localeKeys.includes(key));
		const extraKeys = localeKeys.filter((key) => !baseKeys.includes(key));

		for (const key of missingKeys) {
			errors.push(`${locale}/${file} is missing key ${key}`);
		}

		for (const key of extraKeys) {
			errors.push(`${locale}/${file} has extra key ${key}`);
		}
	}
}

if (errors.length > 0) {
	process.stderr.write(`${errors.join('\n')}\n`);
	process.exit(1);
}

process.stdout.write('i18n message keys are aligned.\n');
