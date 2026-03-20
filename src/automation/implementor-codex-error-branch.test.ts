import { describe, expect, it, vi } from 'vitest';

describe('implementor-codex non-Error rethrow branch', () => {
  it('rethrows non-Error failures from the workflow payload parser unchanged', async () => {
    vi.resetModules();
    vi.doMock('./implementor-runner.js', () => ({
      parseImplementorTaskPayload: () => {
        throw 'raw-failure';
      },
      parseImplementorCommandResult: vi.fn(),
    }));

    const { parseImplementorTaskPayload } = await import('./implementor-codex.js');

    expect(() => parseImplementorTaskPayload('{"repository":"ignored"}')).toThrow('raw-failure');

    vi.doUnmock('./implementor-runner.js');
    vi.resetModules();
  });
});