import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseDocument } from 'yaml';

function loadWorkflow(relativePath: string): any {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  const source = readFileSync(absolutePath, 'utf8');
  return parseDocument(source).toJS();
}

function listWorkflowPaths(): string[] {
  const workflowsDirectory = path.resolve(process.cwd(), '.github/workflows');
  return readdirSync(workflowsDirectory)
    .filter((entry) => entry.endsWith('.yml'))
    .map((entry) => path.posix.join('.github/workflows', entry))
    .sort();
}

describe('GitHub workflow hardening', () => {
  it('disables persisted git credentials on every checkout step', () => {
    const workflowPaths = listWorkflowPaths();
    let checkoutStepCount = 0;

    for (const workflowPath of workflowPaths) {
      const workflow = loadWorkflow(workflowPath);
      const jobs = Object.values<any>(workflow.jobs ?? {});

      for (const job of jobs) {
        const checkoutSteps = (job.steps ?? []).filter((step: any) => step?.uses === 'actions/checkout@v4');
        checkoutStepCount += checkoutSteps.length;

        for (const step of checkoutSteps) {
          expect(step.with?.['persist-credentials'], `${workflowPath} should disable persisted git credentials`).toBe(false);
        }
      }
    }

    expect(checkoutStepCount).toBeGreaterThan(0);
  });

  it('verifies the downloaded MCP scanner release before execution', () => {
    const workflow = loadWorkflow('.github/workflows/mcp-scanner.yml');
    const job = workflow.jobs['mcp-scan'];

    expect(job.env).toMatchObject({
      MCP_SCANNER_VERSION: 'v0.1.1',
      MCP_SCANNER_LINUX_X64_SHA256: '3832e0fc1afa8abb27a71b77447b0bc6a51b0839dead5a548f967e2ea4cde25d',
    });

    const installStep = job.steps.find((step: any) => step.name === 'Install MCP scanner');
    expect(installStep.run).toContain('https://github.com/Oabraham1/mcp-scanner/releases/download/${MCP_SCANNER_VERSION}/${asset}');
    expect(installStep.run).toContain('sha256sum --check --strict');
    expect(installStep.run).toContain('tar -xzf "$asset"');
    expect(installStep.run).not.toContain('beejak/MCP_Scanner');
    expect(installStep.run).not.toContain('chmod +x mcp-sentinel');
  });

  it('pins the OSV reusable workflows to the Node 24-compatible release', () => {
    const workflow = loadWorkflow('.github/workflows/osv-scanner.yml');

    expect(workflow.jobs['scan-scheduled'].uses).toBe(
      'google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@c51854704019a247608d928f370c98740469d4b5',
    );
    expect(workflow.jobs['scan-pr'].uses).toBe(
      'google/osv-scanner-action/.github/workflows/osv-scanner-reusable-pr.yml@c51854704019a247608d928f370c98740469d4b5',
    );
  });
});
