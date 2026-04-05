import type { ImplementorCommandResult } from './implementor-command-result.js';

const validCreatedResult: ImplementorCommandResult = {
  outcome: 'pr-created',
  summary: 'Opened a PR.',
  pullRequest: {
    number: 123,
    url: 'https://example.com/pull/123',
  },
};

const validFailedResult: ImplementorCommandResult = {
  outcome: 'failed',
  summary: 'Tests failed.',
};

// @ts-expect-error pr-created results must include pull request metadata.
const invalidCreatedResult: ImplementorCommandResult = {
  outcome: 'pr-created',
  summary: 'Opened a PR.',
};

const invalidFailedResult: ImplementorCommandResult = {
  outcome: 'failed',
  summary: 'Tests failed.',
  // @ts-expect-error failed results must not carry pull request metadata.
  pullRequest: {
    number: 123,
    url: 'https://example.com/pull/123',
  },
};

void [validCreatedResult, validFailedResult, invalidCreatedResult, invalidFailedResult];
