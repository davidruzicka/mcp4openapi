import { Ajv, type ErrorObject, type JSONSchemaType } from 'ajv';

export interface ImplementorCommandResult {
  readonly outcome: 'pr-created' | 'failed' | 'blocked';
  readonly summary: string;
  readonly pullRequest?: {
    readonly number: number;
    readonly url: string;
  };
}

type ImplementorPullRequestMetadata = NonNullable<ImplementorCommandResult['pullRequest']>;

type ImplementorCommandResultSchema =
  | {
    readonly outcome: 'pr-created';
    readonly summary: string;
    readonly pullRequest: ImplementorPullRequestMetadata;
  }
  | {
    readonly outcome: 'failed' | 'blocked';
    readonly summary: string;
  };

const implementorPullRequestSchema: JSONSchemaType<ImplementorPullRequestMetadata> = {
  type: 'object',
  additionalProperties: false,
  required: ['number', 'url'],
  properties: {
    number: {
      type: 'integer',
    },
    url: {
      type: 'string',
      minLength: 1,
    },
  },
};

export const implementorCommandResultJsonSchema: JSONSchemaType<ImplementorCommandResultSchema> = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'summary', 'pullRequest'],
      properties: {
        outcome: {
          type: 'string',
          const: 'pr-created',
        },
        summary: {
          type: 'string',
          minLength: 1,
        },
        pullRequest: implementorPullRequestSchema,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'summary'],
      properties: {
        outcome: {
          type: 'string',
          enum: ['failed', 'blocked'],
        },
        summary: {
          type: 'string',
          minLength: 1,
        },
      },
    },
  ],
} as const;

const ajv = new Ajv({ allErrors: true, strict: true });
const validateImplementorCommandResultSchema = ajv.compile(implementorCommandResultJsonSchema);

export function parseImplementorCommandResult(raw: string): ImplementorCommandResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid implementor command result: expected JSON object.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid implementor command result: expected object payload.');
  }

  const candidate = parsed as { outcome?: unknown; summary?: unknown; pullRequest?: unknown };
  if (candidate.outcome !== undefined && candidate.outcome !== 'pr-created' && candidate.outcome !== 'failed' && candidate.outcome !== 'blocked') {
    throw new Error('Invalid implementor command result: unsupported outcome.');
  }
  const unexpectedProperty = findUnexpectedImplementorCommandResultProperty(candidate);
  if (unexpectedProperty) {
    throw new Error(`Invalid implementor command result: unexpected property ${unexpectedProperty}.`);
  }
  if (typeof candidate.summary === 'string' && candidate.summary.length === 0) {
    throw new Error('Invalid implementor command result: missing summary.');
  }
  if (candidate.pullRequest !== undefined) {
    if (
      !candidate.pullRequest
      || typeof candidate.pullRequest !== 'object'
      || typeof (candidate.pullRequest as { number?: unknown }).number !== 'number'
      || typeof (candidate.pullRequest as { url?: unknown }).url !== 'string'
    ) {
      throw new Error('Invalid implementor command result: invalid pullRequest payload.');
    }
  }
  if (candidate.outcome === 'pr-created' && candidate.pullRequest === undefined) {
    throw new Error('Invalid implementor command result: pr-created outcome requires pullRequest metadata.');
  }
  if ((candidate.outcome === 'blocked' || candidate.outcome === 'failed') && candidate.pullRequest !== undefined) {
    throw new Error('Invalid implementor command result: schema validation failed.');
  }

  if (!validateImplementorCommandResultSchema(parsed)) {
    throw new Error(formatImplementorCommandResultValidationError(validateImplementorCommandResultSchema.errors));
  }

  return parsed as ImplementorCommandResult;
}

function formatImplementorCommandResultValidationError(errors: readonly ErrorObject[] | null | undefined): string {
  const firstError = errors?.[0];
  if (!firstError) {
    return 'Invalid implementor command result: schema validation failed.';
  }

  if (firstError.keyword === 'additionalProperties') {
    return `Invalid implementor command result: unexpected property ${(firstError.params as { additionalProperty: string }).additionalProperty}.`;
  }

  if (firstError.keyword === 'required') {
    const missingProperty = (firstError.params as { missingProperty: string }).missingProperty;
    return missingProperty === 'pullRequest'
      ? 'Invalid implementor command result: pr-created outcome requires pullRequest metadata.'
      : `Invalid implementor command result: missing ${missingProperty}.`;
  }

  if (firstError.keyword === 'minLength' && firstError.instancePath === '/summary') {
    return 'Invalid implementor command result: missing summary.';
  }

  if (firstError.keyword === 'enum' || firstError.keyword === 'const') {
    return 'Invalid implementor command result: unsupported outcome.';
  }

  if (firstError.instancePath.startsWith('/pullRequest')) {
    return 'Invalid implementor command result: invalid pullRequest payload.';
  }

  if (firstError.keyword === 'oneOf') {
    return inferOneOfValidationError(errors);
  }

  return 'Invalid implementor command result: schema validation failed.';
}

function inferOneOfValidationError(errors: readonly ErrorObject[] | null | undefined): string {
  const unsupportedOutcomeError = errors?.find((error) => error.keyword === 'enum' || error.keyword === 'const');
  if (unsupportedOutcomeError) {
    return 'Invalid implementor command result: unsupported outcome.';
  }

  const missingPullRequestError = errors?.find((error) => error.keyword === 'required' && (error.params as { missingProperty?: string }).missingProperty === 'pullRequest');
  if (missingPullRequestError) {
    return 'Invalid implementor command result: pr-created outcome requires pullRequest metadata.';
  }

  const invalidPullRequestError = errors?.find((error) => error.instancePath.startsWith('/pullRequest'));
  if (invalidPullRequestError) {
    return 'Invalid implementor command result: invalid pullRequest payload.';
  }

  const missingSummaryError = errors?.find((error) => error.keyword === 'minLength' && error.instancePath === '/summary');
  if (missingSummaryError) {
    return 'Invalid implementor command result: missing summary.';
  }

  const unexpectedPropertyError = errors?.find((error) => error.keyword === 'additionalProperties');
  if (unexpectedPropertyError) {
    return `Invalid implementor command result: unexpected property ${(unexpectedPropertyError.params as { additionalProperty: string }).additionalProperty}.`;
  }

  return 'Invalid implementor command result: schema validation failed.';
}

function findUnexpectedImplementorCommandResultProperty(candidate: { outcome?: unknown; [key: string]: unknown }): string | undefined {
  const allowedProperties = new Set(['outcome', 'summary', 'pullRequest']);
  return Object.keys(candidate).find((key) => !allowedProperties.has(key));
}
