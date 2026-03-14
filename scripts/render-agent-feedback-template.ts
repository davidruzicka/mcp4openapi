import {
  buildEvaluatorFeedbackRequestComment,
  shouldRequestFeedbackDetails,
  type AgentStage,
  type FeedbackVerdict,
} from '../src/automation/agent-feedback.js';

interface CliArgs {
  readonly stage: Exclude<AgentStage, 'evaluator'>;
  readonly verdict: Exclude<FeedbackVerdict, 'neutral'>;
  readonly targetAgentId: string;
  readonly targetType: 'issue' | 'pull_request' | 'review' | 'comment';
  readonly targetNumber: number;
  readonly reactionSource: 'thumbs_up' | 'thumbs_down';
  readonly runId: string;
  readonly timestamp: string;
  readonly repository?: string;
  readonly contextSummary?: string;
  readonly humanComment?: string;
  readonly headSha?: string;
  readonly issueNumber?: number;
  readonly prNumber?: number;
}

const args = parseCliArgs(process.argv.slice(2));

if (!shouldRequestFeedbackDetails(args.stage, args.verdict, args.humanComment)) {
  process.stdout.write('No follow-up needed.\n');
  process.exit(0);
}

process.stdout.write(`${buildEvaluatorFeedbackRequestComment(args)}\n`);

function parseCliArgs(argv: readonly string[]): CliArgs {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const nextValue = argv[index + 1];
    if (!nextValue || nextValue.startsWith('--')) {
      throw new Error(`Missing value for argument: ${token}`);
    }

    values.set(token.slice(2), nextValue);
    index += 1;
  }

  return {
    stage: requireEnum(values, 'stage', ['issuer', 'planner', 'implementor', 'reviewer', 'merger']),
    verdict: requireEnum(values, 'verdict', ['positive', 'negative']),
    targetAgentId: requireString(values, 'target-agent-id'),
    targetType: requireEnum(values, 'target-type', ['issue', 'pull_request', 'review', 'comment']),
    targetNumber: requireNumber(values, 'target-number'),
    reactionSource: requireEnum(values, 'reaction-source', ['thumbs_up', 'thumbs_down']),
    runId: values.get('run-id') ?? `manual-${Date.now()}`,
    timestamp: values.get('timestamp') ?? new Date().toISOString(),
    repository: values.get('repository'),
    contextSummary: values.get('context-summary'),
    humanComment: values.get('human-comment'),
    headSha: values.get('head-sha'),
    issueNumber: optionalNumber(values.get('issue-number')),
    prNumber: optionalNumber(values.get('pr-number')),
  };
}

function requireString(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) {
    throw new Error(`Missing required argument --${key}`);
  }

  return value;
}

function requireEnum<T extends string>(values: ReadonlyMap<string, string>, key: string, allowed: readonly T[]): T {
  const value = requireString(values, key);
  if (!allowed.includes(value as T)) {
    throw new Error(`Invalid value for --${key}: ${value}. Allowed: ${allowed.join(', ')}`);
  }

  return value as T;
}

function requireNumber(values: ReadonlyMap<string, string>, key: string): number {
  const value = Number(requireString(values, key));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid numeric value for --${key}`);
  }

  return value;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`Invalid numeric value: ${value}`);
  }

  return numericValue;
}
