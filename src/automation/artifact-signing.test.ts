import { describe, expect, it } from 'vitest';
import {
  signArtifactEnvelope,
  verifyArtifactEnvelope,
  type SignedArtifactEnvelope,
} from './artifact-signing.js';

describe('artifact-signing', () => {
  const signingConfig = {
    key: 'super-secret-signing-key',
    keyId: 'primary',
  };

  const payload = {
    kind: 'review-follow-up' as const,
    threadId: 'thread-1',
    sourceCommentId: 'comment-1',
    headSha: 'abc123',
    fixSummary: 'Cover the fallback path',
    implementationSteps: ['Update fallback handling.'],
    testSteps: ['Add a regression test.'],
    verificationSteps: ['Run targeted automation tests.'],
  };

  it('signs and verifies a review follow-up envelope', () => {
    const envelope = signArtifactEnvelope({
      kind: 'review-follow-up',
      payload,
      config: signingConfig,
    });

    expect(verifyArtifactEnvelope<typeof payload>({
      envelope,
      expectedKind: 'review-follow-up',
      key: signingConfig.key,
    })).toEqual({
      ok: true,
      envelope,
    });
  });

  it('rejects tampered payloads after signing', () => {
    const envelope = signArtifactEnvelope({
      kind: 'review-follow-up',
      payload,
      config: signingConfig,
    });

    const tamperedEnvelope: SignedArtifactEnvelope<typeof payload> = {
      ...envelope,
      payload: {
        ...envelope.payload,
        fixSummary: 'Tampered summary',
      },
    };

    expect(verifyArtifactEnvelope<typeof payload>({
      envelope: tamperedEnvelope,
      expectedKind: 'review-follow-up',
      key: signingConfig.key,
    })).toEqual({
      ok: false,
      reason: 'invalid-signature',
    });
  });

  it('rejects envelopes with a missing signature', () => {
    const envelope = signArtifactEnvelope({
      kind: 'review-follow-up',
      payload,
      config: signingConfig,
    });

    expect(verifyArtifactEnvelope<typeof payload>({
      envelope: {
        ...envelope,
        signature: '',
      },
      expectedKind: 'review-follow-up',
      key: signingConfig.key,
    })).toEqual({
      ok: false,
      reason: 'missing-signature',
    });
  });

  it('rejects envelopes with an unsupported version', () => {
    const envelope = signArtifactEnvelope({
      kind: 'review-follow-up',
      payload,
      config: signingConfig,
    });

    expect(verifyArtifactEnvelope<typeof payload>({
      envelope: {
        ...envelope,
        version: 2,
      },
      expectedKind: 'review-follow-up',
      key: signingConfig.key,
    })).toEqual({
      ok: false,
      reason: 'unsupported-version',
    });
  });

  it('rejects envelopes with an unsupported algorithm', () => {
    const envelope = signArtifactEnvelope({
      kind: 'review-follow-up',
      payload,
      config: signingConfig,
    });

    expect(verifyArtifactEnvelope<typeof payload>({
      envelope: {
        ...envelope,
        algorithm: 'sha1' as never,
      },
      expectedKind: 'review-follow-up',
      key: signingConfig.key,
    })).toEqual({
      ok: false,
      reason: 'unsupported-algorithm',
    });
  });

  it('rejects signed envelopes when the verification key is missing', () => {
    const envelope = signArtifactEnvelope({
      kind: 'review-follow-up',
      payload,
      config: signingConfig,
    });

    expect(verifyArtifactEnvelope<typeof payload>({
      envelope,
      expectedKind: 'review-follow-up',
      key: undefined,
    })).toEqual({
      ok: false,
      reason: 'missing-key',
    });
  });

  it('rejects non-object envelopes and mismatched kinds as unknown format', () => {
    expect(verifyArtifactEnvelope<typeof payload>({
      envelope: 'not-an-object',
      expectedKind: 'review-follow-up',
      key: signingConfig.key,
    })).toEqual({
      ok: false,
      reason: 'unknown-format',
    });

    expect(verifyArtifactEnvelope<typeof payload>({
      envelope: {
        ...signArtifactEnvelope({
          kind: 'review-follow-up',
          payload,
          config: signingConfig,
        }),
        kind: 'different-kind',
      },
      expectedKind: 'review-follow-up',
      key: signingConfig.key,
    })).toEqual({
      ok: false,
      reason: 'unknown-format',
    });
  });

  it('rejects signed envelopes missing key metadata or payload as unknown format', () => {
    const envelope = signArtifactEnvelope({
      kind: 'review-follow-up',
      payload,
      config: signingConfig,
    });

    expect(verifyArtifactEnvelope<typeof payload>({
      envelope: {
        ...envelope,
        keyId: '',
      },
      expectedKind: 'review-follow-up',
      key: signingConfig.key,
    })).toEqual({
      ok: false,
      reason: 'unknown-format',
    });

    expect(verifyArtifactEnvelope<typeof payload>({
      envelope: {
        ...envelope,
        payload: undefined,
      },
      expectedKind: 'review-follow-up',
      key: signingConfig.key,
    })).toEqual({
      ok: false,
      reason: 'unknown-format',
    });
  });

  it('rejects signatures with mismatched lengths before timing-safe comparison', () => {
    const envelope = signArtifactEnvelope({
      kind: 'review-follow-up',
      payload,
      config: signingConfig,
    });

    expect(verifyArtifactEnvelope<typeof payload>({
      envelope: {
        ...envelope,
        signature: 'short',
      },
      expectedKind: 'review-follow-up',
      key: signingConfig.key,
    })).toEqual({
      ok: false,
      reason: 'invalid-signature',
    });
  });
});
