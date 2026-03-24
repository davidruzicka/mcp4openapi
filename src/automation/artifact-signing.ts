import { createHmac, timingSafeEqual } from 'node:crypto';

export type ArtifactSignatureAlgorithm = 'hmac-sha256';

export interface SignedArtifactEnvelope<TPayload> {
  readonly version: 1;
  readonly kind: 'review-follow-up';
  readonly algorithm: ArtifactSignatureAlgorithm;
  readonly keyId: string;
  readonly payload: TPayload;
  readonly signature: string;
}

export interface ArtifactSigningConfig {
  readonly key: string;
  readonly keyId: string;
}

export type ArtifactVerificationResult<TPayload> =
  | { readonly ok: true; readonly envelope: SignedArtifactEnvelope<TPayload> }
  | {
      readonly ok: false;
      readonly reason:
        | 'missing-signature'
        | 'invalid-signature'
        | 'unknown-format'
        | 'unsupported-version'
        | 'unsupported-algorithm'
        | 'missing-key';
    };

const SIGNATURE_ALGORITHM: ArtifactSignatureAlgorithm = 'hmac-sha256';
const SIGNATURE_VERSION = 1;

export function signArtifactEnvelope<TPayload extends object>(input: {
  readonly kind: 'review-follow-up';
  readonly payload: TPayload;
  readonly config: ArtifactSigningConfig;
}): SignedArtifactEnvelope<TPayload> {
  const unsignedEnvelope = {
    version: SIGNATURE_VERSION,
    kind: input.kind,
    algorithm: SIGNATURE_ALGORITHM,
    keyId: input.config.keyId,
    payload: input.payload,
  } as const;

  return {
    ...unsignedEnvelope,
    signature: signEnvelopePayload(unsignedEnvelope, input.config.key),
  };
}

export function verifyArtifactEnvelope<TPayload extends object>(input: {
  readonly envelope: unknown;
  readonly expectedKind: 'review-follow-up';
  readonly key: string | undefined;
}): ArtifactVerificationResult<TPayload> {
  if (!input.envelope || typeof input.envelope !== 'object' || Array.isArray(input.envelope)) {
    return { ok: false, reason: 'unknown-format' };
  }

  const candidate = input.envelope as Partial<SignedArtifactEnvelope<TPayload>>;
  if (candidate.version !== SIGNATURE_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  if (candidate.kind !== input.expectedKind) {
    return { ok: false, reason: 'unknown-format' };
  }
  if (candidate.algorithm !== SIGNATURE_ALGORITHM) {
    return { ok: false, reason: 'unsupported-algorithm' };
  }
  if (typeof candidate.keyId !== 'string' || candidate.keyId.length === 0 || candidate.payload === undefined) {
    return { ok: false, reason: 'unknown-format' };
  }
  if (typeof candidate.signature !== 'string' || candidate.signature.length === 0) {
    return { ok: false, reason: 'missing-signature' };
  }
  if (!input.key || input.key.trim().length === 0) {
    return { ok: false, reason: 'missing-key' };
  }

  const unsignedEnvelope = {
    version: candidate.version,
    kind: candidate.kind,
    algorithm: candidate.algorithm,
    keyId: candidate.keyId,
    payload: candidate.payload,
  } as const;
  const expectedSignature = signEnvelopePayload(unsignedEnvelope, input.key);

  return signaturesMatch(candidate.signature, expectedSignature)
    ? {
        ok: true,
        envelope: candidate as SignedArtifactEnvelope<TPayload>,
      }
    : {
        ok: false,
        reason: 'invalid-signature',
      };
}

function signEnvelopePayload(
  envelope: Pick<SignedArtifactEnvelope<object>, 'version' | 'kind' | 'algorithm' | 'keyId' | 'payload'>,
  key: string,
): string {
  return createHmac('sha256', key)
    .update(JSON.stringify(envelope), 'utf8')
    .digest('hex');
}

function signaturesMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (actualBytes.length !== expectedBytes.length) {
    return false;
  }

  return timingSafeEqual(actualBytes, expectedBytes);
}
