import { describe, expect, it } from 'vitest';
import { isProposalIntakeCreatedIssue } from './agent-metadata-guards.js';

describe('agent-metadata-guards', () => {
  describe('isProposalIntakeCreatedIssue', () => {
    it('returns true for proposal-intake created-issue metadata', () => {
      const body = [
        'Agent-created issue body.',
        '',
        '<!-- AGENT-METADATA',
        'agent-stage: proposal-intake',
        'agent-role: created-issue',
        'source-issue-number: 181',
        '-->',
      ].join('\n');

      expect(isProposalIntakeCreatedIssue(body)).toBe(true);
    });

    it('returns false for missing or non-matching metadata', () => {
      expect(isProposalIntakeCreatedIssue('No metadata here')).toBe(false);

      const wrongStageBody = [
        'Agent-created issue body.',
        '',
        '<!-- AGENT-METADATA',
        'agent-stage: issuer',
        'agent-role: created-issue',
        '-->',
      ].join('\n');

      const wrongRoleBody = [
        'Agent-created issue body.',
        '',
        '<!-- AGENT-METADATA',
        'agent-stage: proposal-intake',
        'agent-role: duplicate-resolution',
        '-->',
      ].join('\n');

      expect(isProposalIntakeCreatedIssue(wrongStageBody)).toBe(false);
      expect(isProposalIntakeCreatedIssue(wrongRoleBody)).toBe(false);
      expect(isProposalIntakeCreatedIssue(undefined)).toBe(false);
    });
  });
});