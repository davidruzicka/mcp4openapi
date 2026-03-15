import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildCodexInvocationPlan,
  parseCodexResult,
  parseImplementorTaskPayload,
} from '../src/automation/implementor-codex.js';

const execFileAsync = promisify(execFile);
const task = parseImplementorTaskPayload(process.env.IMPLEMENTOR_TASK_JSON);
const scratchDirectory = await mkdtemp(join(tmpdir(), 'mcp4openapi-implementor-codex-'));
const outputPath = join(scratchDirectory, 'result.json');

try {
  const plan = buildCodexInvocationPlan({
    task,
    outputPath,
    env: process.env,
    defaultCwd: process.cwd(),
  });

  await writeFile(outputPath, '', 'utf8');
  await execFileAsync(plan.command, [...plan.args], {
    cwd: plan.cwd,
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
  });

  const rawResult = await readFile(outputPath, 'utf8');
  process.stdout.write(`${JSON.stringify(parseCodexResult(rawResult.trim()))}\n`);
} finally {
  await rm(scratchDirectory, { recursive: true, force: true });
}
