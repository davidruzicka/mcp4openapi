import { describe, expect, it } from 'vitest';
import {
  parsePlannerArtifact,
  serializePlannerArtifact,
  type ReviewFixPlanArtifact,
} from './planner-artifact.js';

describe('planner-artifact', () => {
  it('round-trips a valid review follow-up plan artifact', () => {
    const artifact: ReviewFixPlanArtifact = {
      kind: 'review-follow-up',
      threadId: 'thread-1',
      headSha: 'abc123',
      fixSummary: 'Cover fallback path',
      implementationSteps: ['Update fallback handling.'],
      testSteps: ['Add regression test for fallback error path.'],
      verificationSteps: ['Run targeted automation tests.'],
    };

    expect(parsePlannerArtifact(serializePlannerArtifact(artifact))).toEqual(artifact);
  });

  it('rejects artifacts with missing threadId', () => {
    expect(() => parsePlannerArtifact('<!-- AGENT-PLANNER-ARTIFACT\n{"kind":"review-follow-up","headSha":"abc123","fixSummary":"x","implementationSteps":["a"],"testSteps":["b"],"verificationSteps":["c"]}\n-->')).toThrow('Invalid planner artifact');
  });

  it('rejects artifacts with empty step arrays', () => {
    expect(() => parsePlannerArtifact('<!-- AGENT-PLANNER-ARTIFACT\n{"kind":"review-follow-up","threadId":"thread-1","headSha":"abc123","fixSummary":"x","implementationSteps":[],"testSteps":["b"],"verificationSteps":["c"]}\n-->')).toThrow('Invalid planner artifact');
  });

  it('returns undefined for non review-follow-up artifact payloads', () => {
    expect(parsePlannerArtifact('## Implementation plan\n1. Generic issue plan')).toBeUndefined();
  });

  it('rejects artifacts with invalid JSON payloads', () => {
    expect(() => parsePlannerArtifact('<!-- AGENT-PLANNER-ARTIFACT\n{not-json}\n-->')).toThrow(
      'Invalid planner artifact: expected JSON payload.',
    );
  });

  it('rejects non-object artifact payloads', () => {
    expect(() => parsePlannerArtifact('<!-- AGENT-PLANNER-ARTIFACT\n"not-an-object"\n-->')).toThrow(
      'Invalid planner artifact: expected object payload.',
    );
  });

  it('rejects artifacts with unsupported kinds', () => {
    expect(() => parsePlannerArtifact('<!-- AGENT-PLANNER-ARTIFACT\n{"kind":"generic-plan","threadId":"thread-1","headSha":"abc123","fixSummary":"x","implementationSteps":["a"],"testSteps":["b"],"verificationSteps":["c"]}\n-->')).toThrow(
      'Invalid planner artifact: unsupported kind.',
    );
  });

  it('rejects artifacts with missing headSha', () => {
    expect(() => parsePlannerArtifact('<!-- AGENT-PLANNER-ARTIFACT\n{"kind":"review-follow-up","threadId":"thread-1","fixSummary":"x","implementationSteps":["a"],"testSteps":["b"],"verificationSteps":["c"]}\n-->')).toThrow(
      'Invalid planner artifact: missing headSha.',
    );
  });

  it('rejects artifacts with missing fixSummary', () => {
    expect(() => parsePlannerArtifact('<!-- AGENT-PLANNER-ARTIFACT\n{"kind":"review-follow-up","threadId":"thread-1","headSha":"abc123","implementationSteps":["a"],"testSteps":["b"],"verificationSteps":["c"]}\n-->')).toThrow(
      'Invalid planner artifact: missing fixSummary.',
    );
  });
});
