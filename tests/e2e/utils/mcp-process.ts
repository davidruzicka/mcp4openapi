/**
 * MCP Process test harness for E2E tests
 * 
 * Why: Spawns the compiled MCP server as a child process for realistic testing.
 * Supports both stdio and HTTP transport modes.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as readline from 'readline';
import { readFileSync } from 'fs';

export interface McpProcessConfig {
  /** Transport mode */
  transport: 'stdio' | 'http';
  /** Path to OpenAPI spec */
  openapiSpecPath: string;
  /** Path to profile (optional) */
  profilePath?: string;
  /** API base URL override */
  apiBaseUrl?: string;
  /** API token for bearer auth */
  apiToken?: string;
  /** HTTP port (for http transport) */
  httpPort?: number;
  /** Session timeout in ms */
  sessionTimeoutMs?: number;
  /** OAuth configuration */
  oauth?: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
  };
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Log level */
  logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'SILENT';
}

interface ProfileAuthConfig {
  type: string;
  value_from_env?: string;
  oauth_config?: {
    issuer?: string;
    authorization_endpoint?: string;
    token_endpoint?: string;
    client_id?: string;
    client_secret?: string;
    redirect_uri?: string;
  };
}

interface ProfileInterceptors {
  base_url?: {
    value_from_env?: string;
  };
  auth?: ProfileAuthConfig[];
}

interface ProfileDefinition {
  interceptors?: ProfileInterceptors;
}

function parseEnvRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{env:([^}]+)\}$/);
  return match?.[1];
}

function loadProfileDefinition(profilePath: string): ProfileDefinition | undefined {
  try {
    const raw = readFileSync(profilePath, 'utf-8');
    return JSON.parse(raw) as ProfileDefinition;
  } catch {
    return undefined;
  }
}

function resolveProfileEnv(profilePath: string | undefined): {
  authEnvVars: string[];
  baseUrlEnv?: string;
  oauthEnvVars: {
    issuer?: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  };
} {
  if (!profilePath) {
    return { authEnvVars: [], oauthEnvVars: {} };
  }

  const profile = loadProfileDefinition(profilePath);
  const authEnvVars: string[] = [];
  const oauthEnvVars: {
    issuer?: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  } = {};

  const baseUrlEnv = profile?.interceptors?.base_url?.value_from_env;

  for (const auth of profile?.interceptors?.auth ?? []) {
    if (auth.value_from_env) {
      authEnvVars.push(auth.value_from_env);
    }

    if (auth.type !== 'oauth' || !auth.oauth_config) continue;
    oauthEnvVars.issuer = parseEnvRef(auth.oauth_config.issuer) ?? oauthEnvVars.issuer;
    oauthEnvVars.authorizationEndpoint = parseEnvRef(auth.oauth_config.authorization_endpoint) ?? oauthEnvVars.authorizationEndpoint;
    oauthEnvVars.tokenEndpoint = parseEnvRef(auth.oauth_config.token_endpoint) ?? oauthEnvVars.tokenEndpoint;
    oauthEnvVars.clientId = parseEnvRef(auth.oauth_config.client_id) ?? oauthEnvVars.clientId;
    oauthEnvVars.clientSecret = parseEnvRef(auth.oauth_config.client_secret) ?? oauthEnvVars.clientSecret;
    oauthEnvVars.redirectUri = parseEnvRef(auth.oauth_config.redirect_uri) ?? oauthEnvVars.redirectUri;
  }

  return { authEnvVars, baseUrlEnv, oauthEnvVars };
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export class McpProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private config: McpProcessConfig;
  private messageId = 0;
  private pendingRequests = new Map<number | string, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (error: Error) => void;
  }>();
  private readline: readline.Interface | null = null;
  private stdoutBuffer = '';
  private isReady = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private httpSessionId: string | null = null;

  constructor(config: McpProcessConfig) {
    super();
    this.config = config;
  }

  /**
   * Start the MCP server process
   */
  async start(): Promise<void> {
    const distPath = path.resolve(process.cwd(), 'dist/src/index.js');
    const profileEnv = resolveProfileEnv(this.config.profilePath);
    
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      MCP4_TRANSPORT: this.config.transport,
      MCP4_OPENAPI_SPEC_PATH: this.config.openapiSpecPath,
      MCP4_LOG_LEVEL: this.config.logLevel || 'ERROR',
      MCP4_LOG_FORMAT: 'json',
    };

    if (this.config.profilePath) {
      env.MCP4_PROFILE_PATH = this.config.profilePath;
    }

    if (this.config.apiBaseUrl) {
      env.MCP4_API_BASE_URL = this.config.apiBaseUrl;
      if (profileEnv.baseUrlEnv) {
        env[profileEnv.baseUrlEnv] = this.config.apiBaseUrl;
      }
    }

    if (this.config.apiToken) {
      env.MCP4_API_TOKEN = this.config.apiToken;
      for (const authEnv of profileEnv.authEnvVars) {
        env[authEnv] = this.config.apiToken;
      }
    }

    if (this.config.transport === 'http') {
      env.MCP4_HOST = '127.0.0.1';
      env.MCP4_PORT = String(this.config.httpPort || 3003);
    }

    if (this.config.sessionTimeoutMs !== undefined) {
      env.MCP4_SESSION_TIMEOUT_MS = String(this.config.sessionTimeoutMs);
    }

    if (this.config.oauth) {
      env.MCP4_OAUTH_CLIENT_ID = this.config.oauth.clientId;
      env.MCP4_OAUTH_CLIENT_SECRET = this.config.oauth.clientSecret;
      env.MCP4_OAUTH_REDIRECT_URI = this.config.oauth.redirectUri;
      if (this.config.oauth.authorizationEndpoint) {
        env.MCP4_OAUTH_AUTHORIZATION_ENDPOINT = this.config.oauth.authorizationEndpoint;
      }
      if (this.config.oauth.tokenEndpoint) {
        env.MCP4_OAUTH_TOKEN_ENDPOINT = this.config.oauth.tokenEndpoint;
      }

      if (profileEnv.oauthEnvVars.clientId) {
        env[profileEnv.oauthEnvVars.clientId] = this.config.oauth.clientId;
      }
      if (profileEnv.oauthEnvVars.clientSecret) {
        env[profileEnv.oauthEnvVars.clientSecret] = this.config.oauth.clientSecret;
      }
      if (profileEnv.oauthEnvVars.redirectUri) {
        env[profileEnv.oauthEnvVars.redirectUri] = this.config.oauth.redirectUri;
      }
      if (this.config.oauth.authorizationEndpoint && profileEnv.oauthEnvVars.authorizationEndpoint) {
        env[profileEnv.oauthEnvVars.authorizationEndpoint] = this.config.oauth.authorizationEndpoint;
      }
      if (this.config.oauth.tokenEndpoint && profileEnv.oauthEnvVars.tokenEndpoint) {
        env[profileEnv.oauthEnvVars.tokenEndpoint] = this.config.oauth.tokenEndpoint;
      }
    }

    if (this.config.env) {
      Object.assign(env, this.config.env);
    }

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.process = spawn('node', [distPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.on('error', (err) => {
      this.emit('error', err);
    });

    this.process.on('exit', (code, signal) => {
      this.emit('exit', code, signal);
      this.cleanup();
    });

    if (this.config.transport === 'stdio') {
      this.setupStdioHandling();
    } else {
      this.setupHttpHandling();
    }

    // Wait for ready
    await this.waitForReady();
  }

  private setupStdioHandling(): void {
    if (!this.process?.stdout) return;

    this.readline = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });

    this.readline.on('line', (line) => {
      this.handleStdoutLine(line);
    });

    this.process.stderr?.on('data', (data) => {
      const text = data.toString();
      this.emit('stderr', text);
      
      // Check for ready signal in stderr (log messages)
      if (text.includes('MCP server started') || text.includes('listening')) {
        this.markReady();
      }
    });

    // For stdio, we're ready after a short delay (server initializes quickly)
    setTimeout(() => this.markReady(), 500);
  }

  private setupHttpHandling(): void {
    // For HTTP transport, wait for health endpoint
    const port = this.config.httpPort || 3003;
    const healthUrl = `http://127.0.0.1:${port}/health`;

    this.process?.stderr?.on('data', (data) => {
      this.emit('stderr', data.toString());
    });

    const checkHealth = async (): Promise<void> => {
      const maxAttempts = 100;
      const delayMs = 200;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const response = await fetch(healthUrl);
          if (response.ok) {
            this.markReady();
            return;
          }
        } catch {
          // Server not ready yet
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
      throw new Error(`MCP server failed to start (health check failed after ${maxAttempts} attempts)`);
    };

    checkHealth().catch((err) => {
      this.readyReject?.(err);
      this.emit('error', err);
    });
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line) as JsonRpcResponse;
      
      if (message.id !== undefined && message.id !== null) {
        const pending = this.pendingRequests.get(message.id);
        if (pending) {
          this.pendingRequests.delete(message.id);
          pending.resolve(message);
        }
      }

      this.emit('message', message);
    } catch {
      // Not JSON, might be a log line
      this.emit('log', line);
    }
  }

  private markReady(): void {
    if (!this.isReady) {
      this.isReady = true;
      this.readyResolve?.();
      this.readyReject = null;
      this.emit('ready');
    }
  }

  private async waitForReady(): Promise<void> {
    if (this.isReady) return;
    await this.readyPromise;
  }

  /**
   * Send a JSON-RPC request via stdio
   */
  async sendStdio(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    if (this.config.transport !== 'stdio') {
      throw new Error('sendStdio() only works with stdio transport');
    }

    if (!this.process?.stdin) {
      throw new Error('Process stdin not available');
    }

    const id = ++this.messageId;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout for method: ${method}`));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.process!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  /**
   * Send HTTP request to MCP server
   */
  async sendHttp(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {}
  ): Promise<Response> {
    if (this.config.transport !== 'http') {
      throw new Error('sendHttp() only works with http transport');
    }

    const port = this.config.httpPort || 3003;
    const url = `http://127.0.0.1:${port}${path}`;
    const { method = 'GET', body, headers = {} } = options;

    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };

    const headerMap = fetchOptions.headers as Record<string, string>;
    if (this.config.apiToken && !('Authorization' in headerMap)) {
      headerMap['Authorization'] = `Bearer ${this.config.apiToken}`;
    }

    if (body !== undefined) {
      fetchOptions.body = JSON.stringify(body);
    }

    return fetch(url, fetchOptions);
  }

  /**
   * Send JSON-RPC request via HTTP POST /mcp
   */
  async sendHttpJsonRpc(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<JsonRpcResponse> {
    const id = ++this.messageId;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const headers: Record<string, string> = {};
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    const response = await this.sendHttp('/mcp', {
      method: 'POST',
      body: request,
      headers,
    });

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<JsonRpcResponse>;
  }

  /**
   * Initialize MCP session (required for both transports)
   * For HTTP transport, stores session ID for subsequent calls
   */
  async initialize(): Promise<JsonRpcResponse> {
    const params = {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'e2e-test-client',
        version: '1.0.0',
      },
    };

    if (this.config.transport === 'stdio') {
      return this.sendStdio('initialize', params);
    } else {
      // For HTTP, we need to capture the session ID from the response
      const id = ++this.messageId;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params,
      };

      const response = await this.sendHttp('/mcp', {
        method: 'POST',
        body: request,
      });

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
      }

      // Store session ID for subsequent requests
      const sessionId = response.headers.get('Mcp-Session-Id');
      if (sessionId) {
        this.httpSessionId = sessionId;
      }

      return response.json() as Promise<JsonRpcResponse>;
    }
  }

  /**
   * List available tools
   */
  async listTools(sessionId?: string): Promise<JsonRpcResponse> {
    if (this.config.transport === 'stdio') {
      return this.sendStdio('tools/list', {});
    } else {
      return this.sendHttpJsonRpc('tools/list', {}, sessionId || this.httpSessionId || undefined);
    }
  }

  /**
   * Call a tool
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    sessionId?: string
  ): Promise<JsonRpcResponse> {
    const params = { name, arguments: args };

    if (this.config.transport === 'stdio') {
      return this.sendStdio('tools/call', params);
    } else {
      return this.sendHttpJsonRpc('tools/call', params, sessionId || this.httpSessionId || undefined);
    }
  }

  /**
   * Stop the MCP server process
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.process?.kill('SIGKILL');
        resolve();
      }, 5000);

      this.process!.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.process!.kill('SIGTERM');
    });
  }

  private cleanup(): void {
    this.readline?.close();
    this.readline = null;
    this.process = null;
    this.isReady = false;

    for (const [id, { reject }] of this.pendingRequests) {
      reject(new Error('Process exited'));
    }
    this.pendingRequests.clear();
  }

  /**
   * Get the HTTP base URL (only for http transport)
   */
  get httpBaseUrl(): string {
    if (this.config.transport !== 'http') {
      throw new Error('httpBaseUrl only available for http transport');
    }
    return `http://127.0.0.1:${this.config.httpPort || 3003}`;
  }
}
