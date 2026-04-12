import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseDocument } from 'yaml';

const OSV_SCANNER_REUSABLE_SHA = 'c51854704019a247608d928f370c98740469d4b5';
const OSV_SCANNER_SCHEDULED_WORKFLOW = `google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@${OSV_SCANNER_REUSABLE_SHA}`;
const OSV_SCANNER_PR_WORKFLOW = `google/osv-scanner-action/.github/workflows/osv-scanner-reusable-pr.yml@${OSV_SCANNER_REUSABLE_SHA}`;

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

function parseNodeMajorVersion(version: unknown): number | null {
  if (typeof version === 'number' && Number.isInteger(version)) {
    return version;
  }

  if (typeof version !== 'string') {
    return null;
  }

  const trimmedVersion = version.trim();
  if (!/^\d+$/.test(trimmedVersion)) {
    return null;
  }

  return Number.parseInt(trimmedVersion, 10);
}

function resolveNodeMajorVersion(
  version: unknown,
  env: {
    workflowEnv: Record<string, unknown>;
    jobEnv: Record<string, unknown>;
  },
): number | null {
  const directVersion = parseNodeMajorVersion(version);
  if (directVersion !== null) {
    return directVersion;
  }

  if (typeof version !== 'string') {
    return null;
  }

  const envReferenceMatch = version.trim().match(/^\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/);
  if (!envReferenceMatch) {
    return null;
  }

  const envName = envReferenceMatch[1];
  const resolvedValue = env.jobEnv[envName] ?? env.workflowEnv[envName];
  return parseNodeMajorVersion(resolvedValue);
}

describe('node-version parsing', () => {
  it('resolves simple env references from merged workflow and job env maps', () => {
    expect(resolveNodeMajorVersion('${{ env.CI_NODE_VERSION }}', {
      workflowEnv: { CI_NODE_VERSION: '22' },
      jobEnv: {},
    })).toBe(22);

    expect(resolveNodeMajorVersion('${{ env.CI_NODE_VERSION }}', {
      workflowEnv: { CI_NODE_VERSION: '20' },
      jobEnv: { CI_NODE_VERSION: '24' },
    })).toBe(24);
  });

  it('rejects unresolved or non-literal env-backed node versions', () => {
    expect(resolveNodeMajorVersion('${{ env.CI_NODE_VERSION }}', {
      workflowEnv: {},
      jobEnv: {},
    })).toBeNull();

    expect(resolveNodeMajorVersion('${{ env.CI_NODE_VERSION }}', {
      workflowEnv: { CI_NODE_VERSION: '${{ vars.NODE_VERSION }}' },
      jobEnv: {},
    })).toBeNull();

    expect(resolveNodeMajorVersion('${{ matrix.node }}', {
      workflowEnv: { CI_NODE_VERSION: '22' },
      jobEnv: {},
    })).toBeNull();
  });
});

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

  it('runs setup-node steps on Node 22 or newer unless a job intentionally uses a newer runtime', () => {
    const workflowPaths = listWorkflowPaths();
    let setupNodeStepCount = 0;

    for (const workflowPath of workflowPaths) {
      const workflow = loadWorkflow(workflowPath);
      const jobs = Object.values<any>(workflow.jobs ?? {});

      for (const job of jobs) {
        const setupNodeSteps = (job.steps ?? []).filter((step: any) => step?.uses === 'actions/setup-node@v4');
        setupNodeStepCount += setupNodeSteps.length;

        for (const step of setupNodeSteps) {
          const nodeVersion = resolveNodeMajorVersion(step.with?.['node-version'], {
            workflowEnv: workflow.env ?? {},
            jobEnv: job.env ?? {},
          });
          expect(nodeVersion, `${workflowPath} step ${step.name ?? '<unnamed>'} should declare a literal or statically resolvable env-backed node-version`).not.toBeNull();
          expect(nodeVersion, `${workflowPath} step ${step.name ?? '<unnamed>'} should use Node 22 or newer`).toBeGreaterThanOrEqual(22);
        }
      }
    }

    expect(setupNodeStepCount).toBeGreaterThan(0);
  });

  it('pins the OSV reusable workflows to the Node 24-compatible release', () => {
    const workflow = loadWorkflow('.github/workflows/osv-scanner.yml');

    expect(workflow.jobs['scan-scheduled'].uses).toBe(OSV_SCANNER_SCHEDULED_WORKFLOW);
    expect(workflow.jobs['scan-pr'].uses).toBe(OSV_SCANNER_PR_WORKFLOW);
  });
});
