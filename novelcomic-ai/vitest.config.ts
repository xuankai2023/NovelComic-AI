import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

// Package exports point at dist/. Tests import the TypeScript source directly.
const alias = ['config', 'contracts', 'core', 'db', 'errors', 'observability', 'queues', 'runtime', 'storage'].map(
  (name) => ({
    find: new RegExp(`^@novelcomic/${name}$`),
    replacement: path.join(root, 'packages', name, 'src', 'index.ts'),
  }),
);

export default defineConfig({
  resolve: { alias },
  test: { include: ['**/*.test.ts'], exclude: ['**/node_modules/**', '**/dist/**'] },
});
