export interface ReviewFixPlanArtifact {
  readonly kind: 'review-follow-up';
  readonly threadId: string;
  readonly headSha: string;
  readonly fixSummary: string;
  readonly implementationSteps: readonly string[];
  readonly testSteps: readonly string[];
  readonly verificationSteps: readonly string[];
}

const ARTIFACT_PREFIX = '<!-- AGENT-PLANNER-ARTIFACT';
const ARTIFACT_PATTERN = /<!--\s*AGENT-PLANNER-ARTIFACT\n([\s\S]*?)\n-->/;

export function serializePlannerArtifact(artifact: ReviewFixPlanArtifact): string {
  validatePlannerArtifact(artifact);
  return `${ARTIFACT_PREFIX}\n${JSON.stringify(artifact)}\n-->`;
}

export function parsePlannerArtifact(body: string): ReviewFixPlanArtifact | undefined {
  const match = body.match(ARTIFACT_PATTERN);
  if (!match) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1] ?? 'null');
  } catch {
    throw new Error('Invalid planner artifact: expected JSON payload.');
  }

  validatePlannerArtifact(parsed);
  return parsed;
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
