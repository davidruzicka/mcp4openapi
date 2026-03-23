import {
  signArtifactEnvelope,
  verifyArtifactEnvelope,
  type ArtifactSigningConfig,
} from './artifact-signing.js';
import type { ArtifactTrustConfig } from './artifact-signing-config.js';

export interface ReviewFixPlanArtifact {
  readonly kind: 'review-follow-up';
  readonly threadId: string;
  readonly sourceCommentId: string;
  readonly headSha: string;
  readonly fixSummary: string;
  readonly implementationSteps: readonly string[];
  readonly testSteps: readonly string[];
  readonly verificationSteps: readonly string[];
}

export interface ParseTrustedPlannerArtifactOptions {
  readonly trustConfig: ArtifactTrustConfig;
}

export interface ParsedPlannerArtifactComment {
  readonly artifact: ReviewFixPlanArtifact;
  readonly isSigned: boolean;
}

const ARTIFACT_PREFIX = '<!-- AGENT-PLANNER-ARTIFACT';
const ARTIFACT_PATTERN = /<!--\s*AGENT-PLANNER-ARTIFACT\n([\s\S]*?)\n-->/;

export function serializePlannerArtifact(
  artifact: ReviewFixPlanArtifact,
  options?: { readonly signing?: ArtifactSigningConfig },
): string {
  validatePlannerArtifact(artifact);
  const payload = options?.signing
    ? signArtifactEnvelope({
        kind: artifact.kind,
        payload: artifact,
        config: options.signing,
      })
    : artifact;

  return `${ARTIFACT_PREFIX}\n${JSON.stringify(payload)}\n-->`;
}

export function parsePlannerArtifact(body: string): ReviewFixPlanArtifact | undefined {
  return inspectPlannerArtifactComment(body)?.artifact;
}

export function inspectPlannerArtifactComment(body: string): ParsedPlannerArtifactComment | undefined {
  const rawJson = extractPlannerArtifactJson(body);
  if (rawJson === undefined) {
    return undefined;
  }

  const parsed = parsePlannerArtifactJson(rawJson);
  if (isSignedEnvelopeCandidate(parsed)) {
    return {
      artifact: parseLenientSignedEnvelope(parsed),
      isSigned: true,
    };
  }

  validatePlannerArtifact(parsed);
  return {
    artifact: parsed,
    isSigned: false,
  };
}

export function parseTrustedPlannerArtifact(
  body: string,
  options: ParseTrustedPlannerArtifactOptions,
): ReviewFixPlanArtifact | undefined {
  const rawJson = extractPlannerArtifactJson(body);
  if (rawJson === undefined) {
    return undefined;
  }

  const parsed = parsePlannerArtifactJson(rawJson);
  if (isSignedEnvelopeCandidate(parsed)) {
    const verification = verifyArtifactEnvelope<ReviewFixPlanArtifact>({
      envelope: parsed,
      expectedKind: 'review-follow-up',
      key: options.trustConfig.signing?.key,
    });
    if (!verification.ok) {
      throw new Error(`Invalid planner artifact: ${mapVerificationFailureToMessage(verification.reason)}`);
    }

    validatePlannerArtifact(verification.envelope.payload);
    return verification.envelope.payload;
  }

  validatePlannerArtifact(parsed);
  if (!options.trustConfig.allowUnsigned) {
    throw new Error('Invalid planner artifact: unsigned artifacts are not trusted.');
  }

  return parsed;
}

function extractPlannerArtifactJson(body: string): string | undefined {
  const match = body.match(ARTIFACT_PATTERN);
  return match?.[1];
}

function parsePlannerArtifactJson(rawJson: string): unknown {
  try {
    return JSON.parse(rawJson);
  } catch {
    throw new Error('Invalid planner artifact: expected JSON payload.');
  }
}

function parseLenientSignedEnvelope(value: unknown): ReviewFixPlanArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid planner artifact: expected object payload.');
  }

  const envelope = value as {
    version?: unknown;
    kind?: unknown;
    algorithm?: unknown;
    keyId?: unknown;
    payload?: unknown;
    signature?: unknown;
  };
  if (envelope.version !== 1) {
    throw new Error('Invalid planner artifact: signed envelope must use version 1.');
  }
  if (envelope.kind !== 'review-follow-up') {
    throw new Error('Invalid planner artifact: signed envelope kind must be review-follow-up.');
  }
  if (envelope.algorithm !== 'hmac-sha256') {
    throw new Error('Invalid planner artifact: signed envelope must use hmac-sha256.');
  }
  if (typeof envelope.keyId !== 'string' || envelope.keyId.length === 0) {
    throw new Error('Invalid planner artifact: signed envelope must include keyId.');
  }
  if (typeof envelope.signature !== 'string' || envelope.signature.length === 0) {
    throw new Error('Invalid planner artifact: signed envelope must include signature.');
  }

  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid planner artifact: signed envelope must include object payload.');
  }

  validatePlannerArtifact(payload);
  return payload;
}

function isSignedEnvelopeCandidate(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return ['version', 'algorithm', 'keyId', 'payload', 'signature'].some((key) => key in value);
}

function mapVerificationFailureToMessage(
  reason:
    | 'missing-signature'
    | 'invalid-signature'
    | 'unknown-format'
    | 'unsupported-version'
    | 'unsupported-algorithm'
    | 'missing-key',
): string {
  switch (reason) {
    case 'missing-signature':
      return 'missing signature.';
    case 'invalid-signature':
      return 'signature verification failed.';
    case 'unknown-format':
      return 'unrecognized signed envelope format.';
    case 'unsupported-version':
      return 'unsupported signed envelope version.';
    case 'unsupported-algorithm':
      return 'unsupported signature algorithm.';
    case 'missing-key':
      return 'signing key is not configured.';
    default:
      return 'signature verification failed.';
  }
}

function validatePlannerArtifact(value: unknown): asserts value is ReviewFixPlanArtifact {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid planner artifact: expected object payload.');
  }

  const artifact = value as Partial<ReviewFixPlanArtifact>;
  if (artifact.kind !== 'review-follow-up') {
    throw new Error('Invalid planner artifact: unsupported kind.');
  }
  if (typeof artifact.threadId !== 'string' || artifact.threadId.length === 0) {
    throw new Error('Invalid planner artifact: missing threadId.');
  }
  if (typeof artifact.sourceCommentId !== 'string' || artifact.sourceCommentId.length === 0) {
    throw new Error('Invalid planner artifact: missing sourceCommentId.');
  }
  if (typeof artifact.headSha !== 'string' || artifact.headSha.length === 0) {
    throw new Error('Invalid planner artifact: missing headSha.');
  }
  if (typeof artifact.fixSummary !== 'string' || artifact.fixSummary.length === 0) {
    throw new Error('Invalid planner artifact: missing fixSummary.');
  }

  validateStepsArray(artifact.implementationSteps, 'implementationSteps');
  validateStepsArray(artifact.testSteps, 'testSteps');
  validateStepsArray(artifact.verificationSteps, 'verificationSteps');
}

function validateStepsArray(value: unknown, name: string): void {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`Invalid planner artifact: ${name} must be a non-empty string array.`);
  }
}
