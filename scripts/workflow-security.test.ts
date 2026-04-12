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
  const semverLikeMatch = trimmedVersion.match(/^(\d+)(?:\.x|\.\d+(?:\.\d+)?)?$/i);
  if (!semverLikeMatch) {
    return null;
  }

  return Number.parseInt(semverLikeMatch[1], 10);
}

function isSetupNodeActionReference(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmedValue = value.trim();
  return /^actions\/setup-node@[^\s]+$/i.test(trimmedValue);
}

function resolveNodeMajorVersion(
  version: unknown,
  env: {
    workflowEnv: Record<string, unknown>;
    jobEnv: Record<string, unknown>;
    stepEnv: Record<string, unknown>;
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
  for (const envScope of [env.stepEnv, env.jobEnv, env.workflowEnv]) {
    if (Object.prototype.hasOwnProperty.call(envScope, envName)) {
      return parseNodeMajorVersion(envScope[envName]);
    }
  }

  return null;
}

describe('setup-node action matching', () => {
  it('matches setup-node across tags and pinned SHAs without matching other actions', () => {
    expect(isSetupNodeActionReference('actions/setup-node@v4')).toBe(true);
    expect(isSetupNodeActionReference('actions/setup-node@v5')).toBe(true);
    expect(isSetupNodeActionReference('actions/setup-node@8f4b7f84864484a7bf31766abe9204da3cbe65b3')).toBe(true);

    expect(isSetupNodeActionReference('actions/setup-node2@v4')).toBe(false);
    expect(isSetupNodeActionReference('actions/setup-node/subpath@v4')).toBe(false);
    expect(isSetupNodeActionReference('docker://actions/setup-node@v4')).toBe(false);
  });
});

describe('node-version parsing', () => {
  it('resolves explicit numeric and semver-style node-version literals', () => {
    expect(resolveNodeMajorVersion('22', {
      workflowEnv: {},
      jobEnv: {},
      stepEnv: {},
    })).toBe(22);

    expect(resolveNodeMajorVersion('22.x', {
      workflowEnv: {},
      jobEnv: {},
      stepEnv: {},
    })).toBe(22);

    expect(resolveNodeMajorVersion('24.11.0', {
      workflowEnv: {},
      jobEnv: {},
      stepEnv: {},
    })).toBe(24);
  });

  it('resolves env references with step-level precedence over job and workflow env', () => {
    expect(resolveNodeMajorVersion('${{ env.CI_NODE_VERSION }}', {
      workflowEnv: { CI_NODE_VERSION: '22' },
      jobEnv: {},
      stepEnv: {},
    })).toBe(22);

    expect(resolveNodeMajorVersion('${{ env.CI_NODE_VERSION }}', {
      workflowEnv: { CI_NODE_VERSION: '20' },
      jobEnv: { CI_NODE_VERSION: '24' },
      stepEnv: {},
    })).toBe(24);

    expect(resolveNodeMajorVersion('${{ env.CI_NODE_VERSION }}', {
      workflowEnv: { CI_NODE_VERSION: '24' },
      jobEnv: { CI_NODE_VERSION: '22' },
      stepEnv: { CI_NODE_VERSION: '23' },
    })).toBe(23);

    expect(resolveNodeMajorVersion('${{ env.CI_NODE_VERSION }}', {
      workflowEnv: { CI_NODE_VERSION: '22.x' },
      jobEnv: {},
      stepEnv: {},
    })).toBe(22);
  });

  it('rejects unresolved or non-literal env-backed node versions', () => {
    expect(resolveNodeMajorVersion('${{ env.CI_NODE_VERSION }}', {
      workflowEnv: {},
      jobEnv: {},
      stepEnv: {},
    })).toBeNull();

    expect(resolveNodeMajorVersion('${{ env.CI_NODE_VERSION }}', {
      workflowEnv: { CI_NODE_VERSION: '${{ vars.NODE_VERSION }}' },
      jobEnv: {},
      stepEnv: {},
    })).toBeNull();

    expect(resolveNodeMajorVersion('${{ env.CI_NODE_VERSION }}', {
      workflowEnv: { CI_NODE_VERSION: '22' },
      jobEnv: { CI_NODE_VERSION: '23' },
      stepEnv: { CI_NODE_VERSION: '${{ vars.NODE_VERSION }}' },
    })).toBeNull();

    expect(resolveNodeMajorVersion('${{ matrix.node }}', {
      workflowEnv: { CI_NODE_VERSION: '22' },
      jobEnv: {},
      stepEnv: {},
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
        const setupNodeSteps = (job.steps ?? []).filter((step: any) => isSetupNodeActionReference(step?.uses));
        setupNodeStepCount += setupNodeSteps.length;

        for (const step of setupNodeSteps) {
          const nodeVersion = resolveNodeMajorVersion(step.with?.['node-version'], {
            workflowEnv: workflow.env ?? {},
            jobEnv: job.env ?? {},
            stepEnv: step.env ?? {},
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
