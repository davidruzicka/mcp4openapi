import { describe, expect, it, vi } from 'vitest';
import { runImplementorCommandWithFallback } from './implementor-command.js';
import type { ImplementorCommandResult } from '../src/automation/implementor-runner.js';

type RunnerFn = (command: string, payload: unknown) => Promise<ImplementorCommandResult>;

function makeDispatcher(primary: RunnerFn, fallback: RunnerFn): RunnerFn {
  return (command, payload) =>
    command === 'primary-cmd' ? primary(command, payload) : fallback(command, payload);
}

describe('runImplementorCommandWithFallback', () => {
  it('calls fallback when primary command throws at process level', async () => {
    const fallbackResult: ImplementorCommandResult = {
      outcome: 'pr-created',
      summary: 'Fallback succeeded',
      pullRequest: { number: 1, url: 'https://github.com/owner/repo/pull/1' },
    };
    const primaryRunner = vi.fn<RunnerFn>().mockRejectedValue(new Error('ENOENT binary not found'));
    const fallbackRunner = vi.fn<RunnerFn>().mockResolvedValue(fallbackResult);

    const result = await runImplementorCommandWithFallback(
      'primary-cmd', 'fallback-cmd', {}, makeDispatcher(primaryRunner, fallbackRunner),
    );

    expect(primaryRunner).toHaveBeenCalledOnce();
    expect(fallbackRunner).toHaveBeenCalledOnce();
    expect(result).toEqual(fallbackResult);
  });

  it('does NOT call fallback when primary returns outcome: failed', async () => {
    const failedResult: ImplementorCommandResult = { outcome: 'failed', summary: 'agent gave up' };
    const primaryRunner = vi.fn<RunnerFn>().mockResolvedValue(failedResult);
    const fallbackSpy = vi.fn<RunnerFn>();

    const result = await runImplementorCommandWithFallback(
      'primary-cmd', 'fallback-cmd', {}, makeDispatcher(primaryRunner, fallbackSpy),
    );

    expect(primaryRunner).toHaveBeenCalledOnce();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(result).toEqual(failedResult);
  });

  it('does NOT call fallback when primary returns outcome: blocked', async () => {
    const blockedResult: ImplementorCommandResult = { outcome: 'blocked', summary: 'policy block' };
    const primaryRunner = vi.fn<RunnerFn>().mockResolvedValue(blockedResult);
    const fallbackSpy = vi.fn<RunnerFn>();

    const result = await runImplementorCommandWithFallback(
      'primary-cmd', 'fallback-cmd', {}, makeDispatcher(primaryRunner, fallbackSpy),
    );

    expect(primaryRunner).toHaveBeenCalledOnce();
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(result).toEqual(blockedResult);
  });

  it('re-throws primary error when no fallback is configured', async () => {
    const primaryRunner = vi.fn<RunnerFn>().mockRejectedValue(new Error('rate limited'));

    await expect(
      runImplementorCommandWithFallback('primary-cmd', undefined, {}, primaryRunner),
    ).rejects.toThrow('rate limited');

    expect(primaryRunner).toHaveBeenCalledOnce();
  });

  it('reports fallback error when fallback also fails at process level', async () => {
    const primaryRunner = vi.fn<RunnerFn>().mockRejectedValue(new Error('primary crashed'));
    const fallbackRunner = vi.fn<RunnerFn>().mockRejectedValue(new Error('fallback also crashed'));

    await expect(
      runImplementorCommandWithFallback(
        'primary-cmd', 'fallback-cmd', {}, makeDispatcher(primaryRunner, fallbackRunner),
      ),
    ).rejects.toThrow('Primary command failed: primary crashed; fallback also failed: fallback also crashed');

    expect(primaryRunner).toHaveBeenCalledOnce();
    expect(fallbackRunner).toHaveBeenCalledOnce();
  });
});
