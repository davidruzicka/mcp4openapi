import { parseAgentMetadata } from './evaluator-runner.js';

export function isProposalIntakeCreatedIssue(body: string | null | undefined): boolean {
  if (!body) {
    return false;
  }

  const metadata = parseAgentMetadata(body);
  return metadata?.['agent-stage'] === 'proposal-intake'
    && metadata?.['agent-role'] === 'created-issue';
}