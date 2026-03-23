import { describe, expect, it } from 'vitest';
import {
  inspectPlannerArtifactComment,
  parseTrustedPlannerArtifact,
  parsePlannerArtifact,
  serializePlannerArtifact,
  type ReviewFixPlanArtifact,
} from './planner-artifact.js';

const artifact: ReviewFixPlanArtifact = {
  kind: 'review-follow-up',
  threadId: 'thread-1',
  sourceCommentId: 'comment-1',
  headSha: 'abc123',
  fixSummary: 'Cover fallback path',
  implementationSteps: ['Update fallback handling.'],
  testSteps: ['Add regression coverage.'],
  verificationSteps: ['Run targeted automation tests.'],
};

describe('planner-artifact', () => {
  it('round-trips a valid legacy review follow-up plan artifact', () => {
    expect(parsePlannerArtifact(serializePlannerArtifact(artifact))).toEqual(artifact);
  });

  it('round-trips a signed review follow-up plan artifact on trusted paths', () => {
    const body = serializePlannerArtifact(artifact, {
      signing: {
        key: 'signing-secret',
        keyId: 'primary',
      },
    });

    expect(parsePlannerArtifact(body)).toEqual(artifact);
    expect(inspectPlannerArtifactComment(body)).toEqual({
      artifact,
      isSigned: true,
    });
    expect(parseTrustedPlannerArtifact(body, {
      trustConfig: {
        allowUnsigned: false,
        signing: {
          key: 'signing-secret',
          keyId: 'primary',
        },
      },
    })).toEqual(artifact);
  });

  it('rejects legacy unsigned artifacts on trusted paths unless compatibility mode is enabled', () => {
    const body = serializePlannerArtifact(artifact);

    expect(() => parseTrustedPlannerArtifact(body, {
      trustConfig: {
        allowUnsigned: false,
      },
    })).toThrow('unsigned artifacts are not trusted');

    expect(parseTrustedPlannerArtifact(body, {
      trustConfig: {
        allowUnsigned: true,
      },
    })).toEqual(artifact);
  });

  it('rejects tampered signed artifacts on trusted paths', () => {
    const body = serializePlannerArtifact(artifact, {
      signing: {
        key: 'signing-secret',
        keyId: 'primary',
      },
    }).replace('Cover fallback path', 'Tampered summary');

    expect(() => parseTrustedPlannerArtifact(body, {
      trustConfig: {
        allowUnsigned: false,
        signing: {
          key: 'signing-secret',
          keyId: 'primary',
        },
      },
    })).toThrow('signature verification failed');
  });

  it('rejects malformed signed envelopes on trusted paths', () => {
    expect(() => parseTrustedPlannerArtifact([
      '<!-- AGENT-PLANNER-ARTIFACT',
      JSON.stringify({
        version: 1,
        kind: 'review-follow-up',
        algorithm: 'hmac-sha256',
        keyId: 'primary',
        payload: artifact,
      }),
      '-->',
    ].join('\n'), {
      trustConfig: {
        allowUnsigned: false,
        signing: {
          key: 'signing-secret',
          keyId: 'primary',
        },
      },
    })).toThrow('missing signature');

    expect(() => parsePlannerArtifact([
      '<!-- AGENT-PLANNER-ARTIFACT',
      JSON.stringify({
        version: 1,
        kind: 'review-follow-up',
        algorithm: 'hmac-sha256',
        keyId: 'primary',
        payload: 'not-an-object',
        signature: 'abc123',
      }),
      '-->',
    ].join('\n'))).toThrow('signed envelope must include object payload');
  });

  it('validates signed-envelope metadata on lenient and trusted paths', () => {
    expect(() => parsePlannerArtifact([
      '<!-- AGENT-PLANNER-ARTIFACT',
      JSON.stringify({
        version: 2,
        kind: 'review-follow-up',
        algorithm: 'hmac-sha256',
        keyId: 'primary',
        payload: artifact,
        signature: 'abc123',
      }),
      '-->',
    ].join('\n'))).toThrow('signed envelope must use version 1');

    expect(() => parsePlannerArtifact([
      '<!-- AGENT-PLANNER-ARTIFACT',
      JSON.stringify({
        version: 1,
        kind: 'review-follow-up',
        algorithm: 'hmac-sha256',
        keyId: 'primary',
        payload: artifact,
        signature: '',
      }),
      '-->',
    ].join('\n'))).toThrow('signed envelope must include signature');

    expect(() => parseTrustedPlannerArtifact([
      '<!-- AGENT-PLANNER-ARTIFACT',
      JSON.stringify({
        version: 2,
        kind: 'review-follow-up',
        algorithm: 'hmac-sha256',
        keyId: 'primary',
        payload: artifact,
        signature: 'abc123',
      }),
      '-->',
    ].join('\n'), {
      trustConfig: {
        allowUnsigned: false,
        signing: {
          key: 'signing-secret',
          keyId: 'primary',
        },
      },
    })).toThrow('unsupported signed envelope version');

    expect(() => parseTrustedPlannerArtifact([
      '<!-- AGENT-PLANNER-ARTIFACT',
      JSON.stringify({
        version: 1,
        kind: 'review-follow-up',
        algorithm: 'sha1',
        keyId: 'primary',
        payload: artifact,
        signature: 'abc123',
      }),
      '-->',
    ].join('\n'), {
      trustConfig: {
        allowUnsigned: false,
        signing: {
          key: 'signing-secret',
          keyId: 'primary',
        },
      },
    })).toThrow('unsupported signature algorithm');

    expect(() => parseTrustedPlannerArtifact([
      '<!-- AGENT-PLANNER-ARTIFACT',
      JSON.stringify({
        version: 1,
        kind: 'wrong-kind',
        algorithm: 'hmac-sha256',
        keyId: 'primary',
        payload: artifact,
        signature: 'abc123',
      }),
      '-->',
    ].join('\n'), {
      trustConfig: {
        allowUnsigned: false,
        signing: {
          key: 'signing-secret',
          keyId: 'primary',
        },
      },
    })).toThrow('unrecognized signed envelope format');
  });

  it('returns undefined for non review-follow-up artifact payloads', () => {
    expect(parsePlannerArtifact('## Implementation plan\n1. Generic issue plan')).toBeUndefined();
    expect(parseTrustedPlannerArtifact('## Implementation plan\n1. Generic issue plan', {
      trustConfig: {
        allowUnsigned: false,
      },
    })).toBeUndefined();
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
    expect(() => parsePlannerArtifact('<!-- AGENT-PLANNER-ARTIFACT\n{"kind":"generic-plan","threadId":"thread-1","sourceCommentId":"comment-1","headSha":"abc123","fixSummary":"x","implementationSteps":["a"],"testSteps":["b"],"verificationSteps":["c"]}\n-->')).toThrow(
      'Invalid planner artifact: unsupported kind.',
    );
  });

  it('rejects artifacts with missing threadId', () => {
    expect(() => parsePlannerArtifact('<!-- AGENT-PLANNER-ARTIFACT\n{"kind":"review-follow-up","sourceCommentId":"comment-1","headSha":"abc123","fixSummary":"x","implementationSteps":["a"],"testSteps":["b"],"verificationSteps":["c"]}\n-->')).toThrow('Invalid planner artifact');
  });

  it('rejects artifacts with missing sourceCommentId', () => {
    expect(() => parsePlannerArtifact('<!-- AGENT-PLANNER-ARTIFACT\n{"kind":"review-follow-up","threadId":"thread-1","headSha":"abc123","fixSummary":"x","implementationSteps":["a"],"testSteps":["b"],"verificationSteps":["c"]}\n-->')).toThrow(
      'Invalid planner artifact: missing sourceCommentId.',
    );
  });

  it('rejects artifacts with missing headSha', () => {
    expect(() => parsePlannerArtifact('<!-- AGENT-PLANNER-ARTIFACT\n{"kind":"review-follow-up","threadId":"thread-1","sourceCommentId":"comment-1","fixSummary":"x","implementationSteps":["a"],"testSteps":["b"],"verificationSteps":["c"]}\n-->')).toThrow(
      'Invalid planner artifact: missing headSha.',
    );
  });

  it('rejects artifacts with missing fixSummary', () => {
    expect(() => parsePlannerArtifact('<!-- AGENT-PLANNER-ARTIFACT\n{"kind":"review-follow-up","threadId":"thread-1","sourceCommentId":"comment-1","headSha":"abc123","implementationSteps":["a"],"testSteps":["b"],"verificationSteps":["c"]}\n-->')).toThrow(
      'Invalid planner artifact: missing fixSummary.',
    );
  });

  it('rejects artifacts with empty step arrays', () => {
    expect(() => parsePlannerArtifact('<!-- AGENT-PLANNER-ARTIFACT\n{"kind":"review-follow-up","threadId":"thread-1","sourceCommentId":"comment-1","headSha":"abc123","fixSummary":"x","implementationSteps":[],"testSteps":["b"],"verificationSteps":["c"]}\n-->')).toThrow('Invalid planner artifact');
  });
});
