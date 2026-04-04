import { describe, expect, it, vi } from 'vitest';

describe('implementor-codex non-Error parse failure branch', () => {
  it('wraps non-Error failures from the workflow payload parser with the codex backend prefix', async () => {
    vi.resetModules();
    vi.doMock('./implementor-runner.js', () => ({
      parseImplementorTaskPayload: () => {
        throw 'raw-failure';
      },
      parseImplementorCommandResult: vi.fn(),
    }));

    const { parseImplementorTaskPayload } = await import('./implementor-codex.js');

    expect(() => parseImplementorTaskPayload('{"repository":"ignored"}')).toThrow(
      'Codex implementor backend: unknown parse failure',
    );

    vi.doUnmock('./implementor-runner.js');
    vi.resetModules();
  });
});