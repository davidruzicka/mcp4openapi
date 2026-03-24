import { describe, expect, it, vi } from 'vitest';
import { runImplementorCommandWithFallback } from './implementor-fallback.js';
import type { ImplementorCommandResult } from '../src/automation/implementor-runner.js';

describe('runImplementorCommandWithFallback', () => {
  it('calls fallback when primary command throws at process level', async () => {
    const fallbackResult: ImplementorCommandResult = {
      outcome: 'pr-created',
      summary: 'Fallback succeeded',
      pullRequest: { number: 1, url: 'https://github.com/owner/repo/pull/1' },
    };
    const primaryRunner = vi.fn<[string, unknown], Promise<ImplementorCommandResult>>()
      .mockRejectedValue(new Error('ENOENT binary not found'));
    const fallbackRunner = vi.fn<[string, unknown], Promise<ImplementorCommandResult>>()
      .mockResolvedValue(fallbackResult);

    // Inject a combined _runCommand that dispatches by command string
    const _runCommand = async (command: string, payload: unknown) => {
      if (command === 'primary-cmd') return primaryRunner(command, payload);
      return fallbackRunner(command, payload);
    };

    const result = await runImplementorCommandWithFallback('primary-cmd', 'fallback-cmd', {}, _runCommand);

    expect(primaryRunner).toHaveBeenCalledOnce();
    expect(fallbackRunner).toHaveBeenCalledOnce();
    expect(result).toEqual(fallbackResult);
  });

  it('does NOT call fallback when primary returns outcome: failed', async () => {
    const failedResult: ImplementorCommandResult = { outcome: 'failed', summary: 'agent gave up' };
    const fallbackSpy = vi.fn<[string, unknown], Promise<ImplementorCommandResult>>();
    const primaryRunner = vi.fn<[string, unknown], Promise<ImplementorCommandResult>>()
      .mockResolvedValue(failedResult);

    const _runCommand = async (command: string, payload: unknown) => {
      if (command === 'primary-cmd') return primaryRunner(command, payload);
      return fallbackSpy(command, payload);
    };

    const result = await runImplementorCommandWithFallback('primary-cmd', 'fallback-cmd', {}, _runCommand);

    expect(primaryRunner).toHaveBeenCalledOnce();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(result).toEqual(failedResult);
  });

  it('does NOT call fallback when primary returns outcome: blocked', async () => {
    const blockedResult: ImplementorCommandResult = { outcome: 'blocked', summary: 'policy block' };
    const fallbackSpy = vi.fn<[string, unknown], Promise<ImplementorCommandResult>>();
    const primaryRunner = vi.fn<[string, unknown], Promise<ImplementorCommandResult>>()
      .mockResolvedValue(blockedResult);

    const _runCommand = async (command: string, payload: unknown) => {
      if (command === 'primary-cmd') return primaryRunner(command, payload);
      return fallbackSpy(command, payload);
    };

    const result = await runImplementorCommandWithFallback('primary-cmd', 'fallback-cmd', {}, _runCommand);

    expect(primaryRunner).toHaveBeenCalledOnce();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(result).toEqual(blockedResult);
  });

  it('re-throws primary error when no fallback is configured', async () => {
    const primaryError = new Error('rate limited');
    const primaryRunner = vi.fn<[string, unknown], Promise<ImplementorCommandResult>>()
      .mockRejectedValue(primaryError);

    const _runCommand = async (command: string, payload: unknown) => primaryRunner(command, payload);

    await expect(
      runImplementorCommandWithFallback('primary-cmd', undefined, {}, _runCommand),
    ).rejects.toThrow('rate limited');

    expect(primaryRunner).toHaveBeenCalledOnce();
  });

  it('reports fallback error when fallback also fails at process level', async () => {
    const primaryError = new Error('primary crashed');
    const fallbackError = new Error('fallback also crashed');
    const primaryRunner = vi.fn<[string, unknown], Promise<ImplementorCommandResult>>()
      .mockRejectedValue(primaryError);
    const fallbackRunner = vi.fn<[string, unknown], Promise<ImplementorCommandResult>>()
      .mockRejectedValue(fallbackError);

    const _runCommand = async (command: string, payload: unknown) => {
      if (command === 'primary-cmd') return primaryRunner(command, payload);
      return fallbackRunner(command, payload);
    };

    await expect(
      runImplementorCommandWithFallback('primary-cmd', 'fallback-cmd', {}, _runCommand),
    ).rejects.toThrow('Primary command failed: primary crashed; fallback also failed: fallback also crashed');

    expect(primaryRunner).toHaveBeenCalledOnce();
    expect(fallbackRunner).toHaveBeenCalledOnce();
  });
});
