import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const originalEnv = process.env;

type StartupProfileResult = {
  specPath?: string;
  profilePath?: string;
  profileId?: string;
  defaultProfile?: { profileId: string } | undefined;
  hasExplicitSpecPath: boolean;
};

function mockCliConfig() {
  vi.doMock('./cli-config.js', () => ({
    parseCliArgs: () => ({}),
    applyCliEnvOverrides: () => {},
  }));
}

function mockStartupProfile(result: StartupProfileResult) {
  vi.doMock('../profile/startup-profile.js', () => ({
    resolveStartupProfile: async () => result,
  }));
}

function mockStartupValidation(routingError: string | null = null) {
  vi.doMock('../profile/startup-validation.js', () => ({
    getHttpProfileRoutingErrorMessage: () => routingError,
    HTTP_PROFILE_ROUTING_ERROR: 'routing error',
  }));
}

function mockTransportConfig() {
  vi.doMock('../transport/http-transport-config.js', () => ({
    buildHttpTransportBaseConfig: (host: string, port: number) => ({ host, port }),
  }));
}

function mockProfileRegistry() {
  vi.doMock('../profile/profile-registry.js', () => ({
    ProfileRegistry: class {
      constructor() {}
    },
  }));
}

function mockServerManager(options?: {
  getServer?: () => Promise<any>;
  getProfileContext?: () => Promise<any>;
}) {
  const getServer = options?.getServer || (async () => ({
    handleHttpMessage: vi.fn().mockResolvedValue({ ok: true }),
    handleSessionDestroyed: vi.fn(),
  }));
  const getProfileContext = options?.getProfileContext || (async () => ({ profileId: 'default' }));

  vi.doMock('../mcp/mcp-server-manager.js', () => ({
    MCPServerManager: class {
      getServer = getServer;
      getProfileContext = getProfileContext;
    },
  }));
}

function mockLogger() {
  let lastLogger: any;
  class TestLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  }

  vi.doMock('./logger.js', () => ({
    ConsoleLogger: class extends TestLogger {
      constructor() {
        super();
        lastLogger = this;
      }
    },
    JsonLogger: class extends TestLogger {
      constructor() {
        super();
        lastLogger = this;
      }
    },
    __getLastLogger: () => lastLogger,
  }));
}

function mockMcpServer(options?: {
  initialize?: () => Promise<void>;
  runHttp?: () => Promise<void>;
  runStdio?: () => Promise<void>;
  stop?: () => Promise<void>;
}) {
  const initialize = options?.initialize || vi.fn().mockResolvedValue(undefined);
  const runHttp = options?.runHttp || vi.fn().mockResolvedValue(undefined);
  const runStdio = options?.runStdio || vi.fn().mockResolvedValue(undefined);
  const stop = options?.stop || vi.fn().mockResolvedValue(undefined);

  vi.doMock('../mcp/mcp-server.js', () => ({
    MCPServer: class {
      constructor() {}
      initialize = initialize;
      runHttp = runHttp;
      runStdio = runStdio;
      stop = stop;
    },
  }));

  return { initialize, runHttp, runStdio, stop };
}

function mockHttpTransport() {
  const instances: any[] = [];

  class HttpTransport {
    config: any;
    logger: any;
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    setProfileContextProvider = vi.fn();
    setMessageHandler = vi.fn();
    onSessionDestroyed = vi.fn();

    constructor(config: any, logger: any) {
      this.config = config;
      this.logger = logger;
      instances.push(this);
    }
  }

  vi.doMock('../transport/http-transport.js', () => ({
    HttpTransport,
  }));

  return instances;
}

describe('CLI main flow', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    mockMcpServer();
    mockStartupProfile({
      specPath: undefined,
      profilePath: undefined,
      profileId: undefined,
      defaultProfile: undefined,
      hasExplicitSpecPath: false,
    });

    const { main } = await import('./index.js');

    await expect(main()).rejects.toThrow('exit 1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('initializes MCPServer and runs stdio when spec path is present', async () => {
    process.env.MCP4_OPENAPI_SPEC_PATH = 'spec.yaml';
    process.env.MCP4_TRANSPORT = 'stdio';

    const { initialize, runStdio } = mockMcpServer();

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

    const { main } = await import('./index.js');

    await main();

    expect(initialize).toHaveBeenCalledWith('spec.yaml', undefined);
    expect(runStdio).toHaveBeenCalled();
  });

  it('autodiscovers OAuth endpoints from issuer metadata', async () => {
    process.env.MCP4_OAUTH_CLIENT_ID = 'client';
    process.env.MCP4_OAUTH_CLIENT_SECRET = 'secret';
    process.env.MCP4_OAUTH_REDIRECT_URI = 'http://localhost/callback';
    process.env.MCP4_API_BASE_URL = 'https://example.com/api/v4';
    process.env.MCP4_TRANSPORT = 'stdio';

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        authorization_endpoint: 'https://issuer.example.com/auth',
        token_endpoint: 'https://issuer.example.com/token',
      }),
    }));

    mockCliConfig();
    mockStartupValidation();
    mockTransportConfig();
    mockProfileRegistry();
    mockServerManager();
    mockMcpServer();
    mockStartupProfile({
      specPath: 'spec.yaml',
      profilePath: undefined,
      profileId: undefined,
      defaultProfile: undefined,
      hasExplicitSpecPath: true,
    });

    const { main } = await import('./index.js');

    await main();

    expect(process.env.MCP4_OAUTH_AUTHORIZATION_URL).toBe('https://issuer.example.com/auth');
    expect(process.env.MCP4_OAUTH_TOKEN_URL).toBe('https://issuer.example.com/token');
  });

  it('falls back to standard OAuth paths when metadata fetch fails', async () => {
    process.env.MCP4_OAUTH_CLIENT_ID = 'client';
    process.env.MCP4_OAUTH_CLIENT_SECRET = 'secret';
    process.env.MCP4_OAUTH_REDIRECT_URI = 'http://localhost/callback';
    process.env.MCP4_OAUTH_ISSUER = 'https://issuer.example.com';
    process.env.MCP4_TRANSPORT = 'stdio';

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    mockCliConfig();
    mockStartupValidation();
    mockTransportConfig();
    mockProfileRegistry();
    mockServerManager();
    mockMcpServer();
    mockStartupProfile({
      specPath: 'spec.yaml',
      profilePath: undefined,
      profileId: undefined,
      defaultProfile: undefined,
      hasExplicitSpecPath: true,
    });

    const { main } = await import('./index.js');

    await main();

    expect(process.env.MCP4_OAUTH_AUTHORIZATION_URL).toBe('https://issuer.example.com/oauth/authorize');
    expect(process.env.MCP4_OAUTH_TOKEN_URL).toBe('https://issuer.example.com/oauth/token');
  });

  it('uses legacy issuer when credentials are missing', async () => {
    delete process.env.MCP4_OAUTH_CLIENT_ID;
    delete process.env.MCP4_OAUTH_CLIENT_SECRET;
    delete process.env.MCP4_OAUTH_REDIRECT_URI;
    process.env.MCP4_OAUTH_ISSUER = 'https://legacy.example.com';
    process.env.MCP4_TRANSPORT = 'stdio';

    mockCliConfig();
    mockStartupValidation();
    mockTransportConfig();
    mockProfileRegistry();
    mockServerManager();
    mockMcpServer();
    mockStartupProfile({
      specPath: 'spec.yaml',
      profilePath: undefined,
      profileId: undefined,
      defaultProfile: undefined,
      hasExplicitSpecPath: true,
    });

    const { main } = await import('./index.js');

    await main();

    expect(process.env.MCP4_OAUTH_AUTHORIZATION_URL).toBe('https://legacy.example.com/oauth/authorize');
    expect(process.env.MCP4_OAUTH_TOKEN_URL).toBe('https://legacy.example.com/oauth/token');
  });

  it('exits on routing error', async () => {
    process.env.MCP4_TRANSPORT = 'http';
    process.env.MCP4_HTTP_PROFILE_ROUTING = 'true';

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as never);

    mockCliConfig();
    mockStartupValidation('routing error');
    mockTransportConfig();
    mockProfileRegistry();
    mockServerManager();
    mockMcpServer();
    mockStartupProfile({
      specPath: 'spec.yaml',
      profilePath: undefined,
      profileId: undefined,
      defaultProfile: undefined,
      hasExplicitSpecPath: true,
    });

    const { main } = await import('./index.js');

    await expect(main()).rejects.toThrow('exit 1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('wires HTTP routing transport and handlers', async () => {
    process.env.MCP4_TRANSPORT = 'http';
    process.env.MCP4_HTTP_PROFILE_ROUTING = 'true';
    process.env.MCP4_OPENAPI_SPEC_PATH = 'spec.yaml';

    mockLogger();
    mockCliConfig();
    mockStartupValidation();
    mockTransportConfig();
    mockProfileRegistry();

    const server = {
      handleHttpMessage: vi.fn().mockResolvedValue({ ok: true }),
      handleSessionDestroyed: vi.fn(),
    };

    mockServerManager({
      getServer: async () => server,
      getProfileContext: async () => ({ profileId: 'default' }),
    });

    const httpTransportInstances = mockHttpTransport();
    mockMcpServer();
    mockStartupProfile({
      specPath: 'spec.yaml',
      profilePath: undefined,
      profileId: undefined,
      defaultProfile: { profileId: 'default' },
      hasExplicitSpecPath: true,
    });

    const onHandlers: Record<string, () => void> = {};
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => void) => {
      onHandlers[event] = handler;
      return process;
    }) as never);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      if (code === 0) {
        return undefined as never;
      }
      throw new Error(`exit ${code}`);
    }) as never);

    const { main } = await import('./index.js');

    await main();

    const httpTransport = httpTransportInstances[0];
    expect(httpTransport.start).toHaveBeenCalled();
    expect(httpTransport.setProfileContextProvider).toHaveBeenCalled();
    expect(httpTransport.setMessageHandler).toHaveBeenCalled();
    expect(httpTransport.onSessionDestroyed).toHaveBeenCalled();

    const messageHandler = httpTransport.setMessageHandler.mock.calls[0][0];
    await expect(messageHandler({}, 'session', undefined)).rejects.toThrow('Profile ID is required');
    await messageHandler({}, 'session', 'default');
    expect(server.handleHttpMessage).toHaveBeenCalled();

    const sessionHandler = httpTransport.onSessionDestroyed.mock.calls[0][0];
    await sessionHandler('default', 'session');
    expect(server.handleSessionDestroyed).toHaveBeenCalled();

    httpTransport.stop.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('stop failed'));

    await onHandlers.SIGTERM();
    expect(httpTransport.stop).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);

    await expect(onHandlers.SIGINT()).rejects.toThrow('exit 1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('runs HTTP transport without routing when disabled', async () => {
    process.env.MCP4_TRANSPORT = 'http';
    process.env.MCP4_HTTP_PROFILE_ROUTING = 'false';
    process.env.MCP4_OPENAPI_SPEC_PATH = 'spec.yaml';

    const { runHttp } = mockMcpServer();

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

    const { main } = await import('./index.js');

    await main();

    expect(runHttp).toHaveBeenCalled();
  });

  it('exits on fatal server initialization error', async () => {
    process.env.MCP4_TRANSPORT = 'stdio';
    process.env.MCP4_OPENAPI_SPEC_PATH = 'spec.yaml';

    const initialize = vi.fn().mockRejectedValue(new Error('boom'));

    mockCliConfig();
    mockStartupValidation();
    mockTransportConfig();
    mockProfileRegistry();
    mockServerManager();
    mockMcpServer({ initialize });
    mockStartupProfile({
      specPath: 'spec.yaml',
      profilePath: undefined,
      profileId: undefined,
      defaultProfile: undefined,
      hasExplicitSpecPath: true,
    });

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as never);

    const { main } = await import('./index.js');

    await expect(main()).rejects.toThrow('exit 1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
