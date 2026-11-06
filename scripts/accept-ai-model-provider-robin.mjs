#!/usr/bin/env node
/**
 * 按 AI 模型注册、Provider 与 Robin 的验收顺序跑完整链路。
 *
 * 用法（在 NovelComic-AI 仓库根目录）：
 *   node scripts/accept-ai-model-provider-robin.mjs
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const aiRoot = join(repoRoot, '..', 'novelcomic-ai');
const scriptPath = join(repoRoot, 'accept-ai-model-provider-robin.mts');

const requireFromAi = createRequire(join(aiRoot, 'package.json'));
const vitestPackageJson = requireFromAi.resolve('vitest/package.json');
const requireFromVitest = createRequire(vitestPackageJson);
const viteNodePackageJson = requireFromVitest.resolve('vite-node/package.json');
const viteNodeBin = join(dirname(viteNodePackageJson), 'vite-node.mjs');

const child = spawn(process.execPath, [
  viteNodeBin,
  '--root', join(repoRoot, '..'),
  '--config', join(aiRoot, 'vitest.config.ts'),
  scriptPath,
], {
  cwd: aiRoot,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 1);
});
