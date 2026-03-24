import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseImplementorCommandResult,
  type ImplementorCommandResult,
} from '../src/automation/implementor-runner.js';

const execFileAsync = promisify(execFile);

export async function runImplementorCommand(command: string, payload: unknown): Promise<ImplementorCommandResult> {
  const { stdout } = await execFileAsync('bash', ['-lc', command], {
    env: {
      ...process.env,
      IMPLEMENTOR_TASK_JSON: JSON.stringify(payload),
    },
    maxBuffer: 2 * 1024 * 1024,
  });

  return parseImplementorCommandResult(stdout.trim());
}

export async function runImplementorCommandWithFallback(
  primaryCommand: string,
  fallbackCommand: string | undefined,
  payload: unknown,
  _runCommand = runImplementorCommand,
): Promise<ImplementorCommandResult> {
  try {
    return await _runCommand(primaryCommand, payload);
  } catch (primaryError: unknown) {
    if (!fallbackCommand) {
      throw primaryError;
    }
    try {
      return await _runCommand(fallbackCommand, payload);
    } catch (fallbackError: unknown) {
      const primaryMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
      const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`Primary command failed: ${primaryMsg}; fallback also failed: ${fallbackMsg}`);
    }
  }
}
