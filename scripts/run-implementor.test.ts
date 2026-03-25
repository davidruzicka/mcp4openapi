import { describe, expect, it, vi } from 'vitest';
import { runImplementorCommandWithFallback } from './implementor-command.js';
import type { ImplementorCommandResult, RunImplementorCommandOptions } from './implementor-command.js';

type RunnerFn = (command: string, payload: unknown, options?: RunImplementorCommandOptions) => Promise<ImplementorCommandResult>;

function makeDispatcher(primary: RunnerFn, fallback: RunnerFn): RunnerFn {
  return (command, payload, options) =>
    command === 'primary-cmd' ? primary(command, payload, options) : fallback(command, payload, options);
}

const TEST_PAYLOAD = { issueNumber: 42 };
const TEST_OPTIONS: RunImplementorCommandOptions = { timeoutMs: 5000 };

describe('runImplementorCommandWithFallback', () => {
  it('returns primary result and does not call fallback on success', async () => {
    const successResult: ImplementorCommandResult = {
      outcome: 'pr-created',
      summary: 'PR created successfully',
      pullRequest: { number: 7, url: 'https://github.com/owner/repo/pull/7' },
    };
    const primaryRunner = vi.fn<RunnerFn>().mockResolvedValue(successResult);
    const fallbackSpy = vi.fn<RunnerFn>();

    const result = await runImplementorCommandWithFallback(
      'primary-cmd', 'fallback-cmd', TEST_PAYLOAD, TEST_OPTIONS, makeDispatcher(primaryRunner, fallbackSpy),
    );

    expect(primaryRunner).toHaveBeenCalledOnce();
    expect(primaryRunner).toHaveBeenCalledWith('primary-cmd', TEST_PAYLOAD, TEST_OPTIONS);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(result).toEqual(successResult);
  });

  it('calls fallback when primary command throws at process level', async () => {
    const fallbackResult: ImplementorCommandResult = {
      outcome: 'pr-created',
      summary: 'Fallback succeeded',
      pullRequest: { number: 1, url: 'https://github.com/owner/repo/pull/1' },
    };
    const primaryRunner = vi.fn<RunnerFn>().mockRejectedValue(new Error('ENOENT binary not found'));
    const fallbackRunner = vi.fn<RunnerFn>().mockResolvedValue(fallbackResult);

    const result = await runImplementorCommandWithFallback(
      'primary-cmd', 'fallback-cmd', TEST_PAYLOAD, TEST_OPTIONS, makeDispatcher(primaryRunner, fallbackRunner),
    );

    expect(primaryRunner).toHaveBeenCalledOnce();
    expect(primaryRunner).toHaveBeenCalledWith('primary-cmd', TEST_PAYLOAD, TEST_OPTIONS);
    expect(fallbackRunner).toHaveBeenCalledOnce();
    expect(fallbackRunner).toHaveBeenCalledWith('fallback-cmd', TEST_PAYLOAD, TEST_OPTIONS);
    expect(result).toEqual(fallbackResult);
  });

  it('does NOT call fallback when primary returns outcome: failed', async () => {
    const failedResult: ImplementorCommandResult = { outcome: 'failed', summary: 'agent gave up' };
    const primaryRunner = vi.fn<RunnerFn>().mockResolvedValue(failedResult);
    const fallbackSpy = vi.fn<RunnerFn>();

    const result = await runImplementorCommandWithFallback(
      'primary-cmd', 'fallback-cmd', TEST_PAYLOAD, TEST_OPTIONS, makeDispatcher(primaryRunner, fallbackSpy),
    );

    expect(primaryRunner).toHaveBeenCalledOnce();
    expect(primaryRunner).toHaveBeenCalledWith('primary-cmd', TEST_PAYLOAD, TEST_OPTIONS);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(result).toEqual(failedResult);
  });

  it('does NOT call fallback when primary returns outcome: blocked', async () => {
    const blockedResult: ImplementorCommandResult = { outcome: 'blocked', summary: 'policy block' };
    const primaryRunner = vi.fn<RunnerFn>().mockResolvedValue(blockedResult);
    const fallbackSpy = vi.fn<RunnerFn>();

    const result = await runImplementorCommandWithFallback(
      'primary-cmd', 'fallback-cmd', TEST_PAYLOAD, TEST_OPTIONS, makeDispatcher(primaryRunner, fallbackSpy),
    );

    expect(primaryRunner).toHaveBeenCalledOnce();
    expect(primaryRunner).toHaveBeenCalledWith('primary-cmd', TEST_PAYLOAD, TEST_OPTIONS);
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(result).toEqual(blockedResult);
  });

  it('re-throws primary error when no fallback is configured', async () => {
    const primaryRunner = vi.fn<RunnerFn>().mockRejectedValue(new Error('rate limited'));

    await expect(
      runImplementorCommandWithFallback('primary-cmd', undefined, TEST_PAYLOAD, TEST_OPTIONS, primaryRunner),
    ).rejects.toThrow('rate limited');

    expect(primaryRunner).toHaveBeenCalledOnce();
    expect(primaryRunner).toHaveBeenCalledWith('primary-cmd', TEST_PAYLOAD, TEST_OPTIONS);
  });

  it('reports fallback error when fallback also fails at process level', async () => {
    const primaryRunner = vi.fn<RunnerFn>().mockRejectedValue(new Error('primary crashed'));
    const fallbackRunner = vi.fn<RunnerFn>().mockRejectedValue(new Error('fallback also crashed'));

    await expect(
      runImplementorCommandWithFallback(
        'primary-cmd', 'fallback-cmd', TEST_PAYLOAD, TEST_OPTIONS, makeDispatcher(primaryRunner, fallbackRunner),
      ),
    ).rejects.toThrow('Primary command failed: primary crashed; fallback also failed: fallback also crashed');

    expect(primaryRunner).toHaveBeenCalledOnce();
    expect(fallbackRunner).toHaveBeenCalledOnce();
  });
});
