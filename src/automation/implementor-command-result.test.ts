import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  implementorCommandResultJsonSchema,
  parseImplementorCommandResult,
} from './implementor-command-result.js';

describe('implementor-command-result', () => {
  describe('Ajv runtime compatibility', () => {
    it('supports the direct Ajv constructor path used by the ESM runtime', () => {
      expect(() => new Ajv({ allErrors: true, strict: true }).compile(implementorCommandResultJsonSchema)).not.toThrow();
    });
  });

  describe('parseImplementorCommandResult', () => {
    it('accepts valid failed and blocked payloads without pull request metadata', () => {
      expect(parseImplementorCommandResult('{"outcome":"failed","summary":"Tests failed."}')).toEqual({
        outcome: 'failed',
        summary: 'Tests failed.',
      });
      expect(parseImplementorCommandResult('{"outcome":"blocked","summary":"Waiting for a human decision."}')).toEqual({
        outcome: 'blocked',
        summary: 'Waiting for a human decision.',
      });
    });

    it('accepts a valid pr-created payload with pull request metadata', () => {
      expect(parseImplementorCommandResult('{"outcome":"pr-created","summary":"Opened a PR.","pullRequest":{"number":123,"url":"https://example.com/pull/123"}}')).toEqual({
        outcome: 'pr-created',
        summary: 'Opened a PR.',
        pullRequest: {
          number: 123,
          url: 'https://example.com/pull/123',
        },
      });
    });

    it('reports missing summary through schema validation', () => {
      expect(() => parseImplementorCommandResult('{"outcome":"failed"}')).toThrow('Invalid implementor command result: missing summary.');
    });

    it('rejects malformed pull request metadata via the shared schema validator', () => {
      expect(() => parseImplementorCommandResult('{"outcome":"pr-created","summary":"Opened a PR.","pullRequest":{"number":"1","url":"https://example.com/pull/1"}}')).toThrow('Invalid implementor command result: invalid pullRequest payload.');
      expect(() => parseImplementorCommandResult('{"outcome":"pr-created","summary":"Opened a PR.","pullRequest":{"number":1}}')).toThrow('Invalid implementor command result: invalid pullRequest payload.');
    });

    it('reports schema-level pull request validation failures after the shape guard passes', () => {
      expect(() => parseImplementorCommandResult('{"outcome":"pr-created","summary":"Opened a PR.","pullRequest":{"number":123,"url":""}}')).toThrow('Invalid implementor command result: invalid pullRequest payload.');
    });

    it('rejects nested additional properties deterministically', () => {
      expect(() => parseImplementorCommandResult('{"outcome":"pr-created","summary":"Opened a PR.","pullRequest":{"number":1,"url":"https://example.com/pull/1","extra":true}}')).toThrow('Invalid implementor command result: unexpected property extra.');
    });
  });
});
