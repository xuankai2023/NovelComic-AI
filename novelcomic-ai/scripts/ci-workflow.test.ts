import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflow = path.join(path.dirname(fileURLToPath(import.meta.url)), '../.github/workflows/ci.yml');

type Step = {
  name: string;
  run: string;
  continueOnError: boolean;
  ifCondition: string;
};

function parseSteps(text: string): Step[] {
  const steps: Step[] = [];
  let current: Step | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('      - name:')) {
      if (current) steps.push(current);
      current = {
        name: line.slice(line.indexOf(':') + 1).trim(),
        run: '',
        continueOnError: false,
        ifCondition: '',
      };
      continue;
    }
    if (!current) continue;
    const stripped = line.trim();
    if (stripped.startsWith('continue-on-error:')) {
      current.continueOnError = stripped.endsWith('true');
    } else if (stripped.startsWith('if:')) {
      current.ifCondition = stripped.slice(stripped.indexOf(':') + 1).trim();
    } else if (stripped.startsWith('run:')) {
      current.run = stripped.slice(stripped.indexOf(':') + 1).trim();
    }
  }
  if (current) steps.push(current);
  return steps;
}

function conclude(steps: Step[], failingRun: string) {
  let failed = false;
  const ran: string[] = [];
  for (const step of steps) {
    const condition = step.ifCondition || 'success()';
    if (condition === 'success()' && failed) continue;
    if (condition === 'failure()' && !failed) continue;
    ran.push(step.name);
    if (step.run.includes(failingRun) && !step.continueOnError) failed = true;
  }
  return { status: failed ? 'failure' : 'success', ran };
}

describe('ai CI workflow', () => {
  const text = readFileSync(workflow, 'utf8');
  const steps = parseSteps(text);

  it('runs locked install, lint, typecheck, and unit tests on pull requests and trunk pushes', () => {
    expect(text).toContain('pull_request:');
    expect(text.match(/branches: \[main, develop\]/g)).toHaveLength(2);
    expect(steps.map((step) => step.run).filter(Boolean)).toEqual([
      'corepack enable',
      'pnpm install --frozen-lockfile',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
    ]);
    expect(text).not.toMatch(/continue-on-error/);
    expect(text).not.toMatch(/test:kling|pnpm build/);
  });

  it('fails the job when lint or test fails and does not keep going', () => {
    for (const failingRun of ['pnpm lint', 'pnpm typecheck', 'pnpm test']) {
      const result = conclude(steps, failingRun);
      expect(result.status).toBe('failure');
      expect(result.ran.at(-1)).toBe(steps.find((step) => step.run === failingRun)?.name);
    }
  });
});
