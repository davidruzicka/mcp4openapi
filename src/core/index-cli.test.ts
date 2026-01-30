import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const originalEnv = process.env;

function mockCliConfig() {
  vi.doMock('./cli-config.js', () => ({
    parseCliArgs: () => ({}),
    applyCliEnvOverrides: () => {},
  }));
}

function mockStartupProfile(result: {
  specPath?: string;
  profilePath?: string;
  profileId?: string;
  defaultProfile?: { profileId: string } | undefined;
  hasExplicitSpecPath: boolean;
}) {
  vi.doMock('../profile/startup-profile.js', () => ({
    resolveStartupProfile: async () => result,
  }));
}

function mockStartupValidation() {
  vi.doMock('../profile/startup-validation.js', () => ({
    getHttpProfileRoutingErrorMessage: () => null,
    HTTP_PROFILE_ROUTING_ERROR: 'routing error',
  }));
}

function mockTransportConfig() {
  vi.doMock('../transport/http-transport-config.js', () => ({
    buildHttpTransportBaseConfig: () => ({ host: '127.0.0.1', port: 3003 }),
  }));
}

function mockProfileRegistry() {
  vi.doMock('../profile/profile-registry.js', () => ({
    ProfileRegistry: class {},
  }));
}

function mockServerManager() {
  vi.doMock('../mcp/mcp-server-manager.js', () => ({
    MCPServerManager: class {},
  }));
}

describe('CLI main flow', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('exits when spec path is missing for stdio', async () => {
    delete process.env.MCP4_OPENAPI_SPEC_PATH;
    process.env.MCP4_TRANSPORT = 'stdio';

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as never);

    mockCliConfig();
    mockStartupValidation();
    mockTransportConfig();
    mockProfileRegistry();
    mockServerManager();
    mockStartupProfile({
      specPath: undefined,
      profilePath: undefined,
      profileId: undefined,
      defaultProfile: undefined,
      hasExplicitSpecPath: false,
    });

    vi.doMock('../mcp/mcp-server.js', () => ({
      MCPServer: class {
        async initialize() {}
        async runStdio() {}
        async runHttp() {}
        async stop() {}
      },
    }));

    const { main } = await import('./index.js');

    await expect(main()).rejects.toThrow('exit 1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('initializes MCPServer and runs stdio when spec path is present', async () => {
    process.env.MCP4_OPENAPI_SPEC_PATH = 'spec.yaml';
    process.env.MCP4_TRANSPORT = 'stdio';

    const initialize = vi.fn().mockResolvedValue(undefined);
    const runStdio = vi.fn().mockResolvedValue(undefined);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    mockCliConfig();
    mockStartupValidation();
    mockTransportConfig();
    mockProfileRegistry();
    mockServerManager();
    mockStartupProfile({
      specPath: 'spec.yaml',
      profilePath: undefined,
      profileId: undefined,
      defaultProfile: undefined,
      hasExplicitSpecPath: true,
    });

    vi.doMock('../mcp/mcp-server.js', () => ({
      MCPServer: class {
        constructor() {}
        initialize = initialize;
        runStdio = runStdio;
        runHttp = vi.fn();
        stop = vi.fn();
      },
    }));

    const { main } = await import('./index.js');

    await main();

    expect(initialize).toHaveBeenCalledWith('spec.yaml', undefined);
    expect(runStdio).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
