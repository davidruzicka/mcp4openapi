import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseImplementorCommandResult,
  type ImplementorCommandResult,
} from '../src/automation/implementor-runner.js';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface RunImplementorCommandOptions {
  readonly timeoutMs?: number;
}

export async function runImplementorCommand(
  command: string,
  payload: unknown,
  options?: RunImplementorCommandOptions,
): Promise<ImplementorCommandResult> {
  const { stdout } = await execFileAsync('bash', ['-lc', command], {
    env: {
      ...process.env,
      IMPLEMENTOR_TASK_JSON: JSON.stringify(payload),
    },
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: options?.timeoutMs,
    killSignal: 'SIGTERM',
  });

  return parseImplementorCommandResult(stdout.trim());
}

export async function runImplementorCommandWithFallback(
  primaryCommand: string,
  fallbackCommand: string | undefined,
  payload: unknown,
  options?: RunImplementorCommandOptions,
  runCommandFn = runImplementorCommand,
): Promise<ImplementorCommandResult> {
  try {
    return await runCommandFn(primaryCommand, payload, options);
  } catch (primaryError: unknown) {
    if (!fallbackCommand) {
      throw primaryError;
    }
    try {
      return await runCommandFn(fallbackCommand, payload, options);
    } catch (fallbackError: unknown) {
      const primaryMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
      const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`Primary command failed: ${primaryMsg}; fallback also failed: ${fallbackMsg}`);
    }
  }
}
