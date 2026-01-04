/**
 * Standalone mock server for E2E tests
 *
 * Why: Creates a real HTTP server for process-based testing.
 * The MCP server runs as a separate process and needs actual network endpoints.
 */

import express, { Request, Response } from 'express';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';

export interface OAuthConfig {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface MockServerConfig {
  /** Port to listen on (0 = random available port) */
  port?: number;
  /** GitLab API base path (default: /api/v4) */
  apiBasePath?: string;
  /** OAuth configuration */
  oauth?: OAuthConfig;
}

export interface MockServerInstance {
  /** The HTTP server instance */
  server: Server;
  /** The actual port the server is listening on */
  port: number;
  /** Base URL for GitLab API (e.g., http://localhost:3001/api/v4) */
  gitlabApiUrl: string;
  /** Base URL for OAuth endpoints (e.g., http://localhost:3001) */
  oauthUrl: string;
  /** Stop the server */
  stop: () => Promise<void>;
}

interface BranchState {
  name: string;
  protected: boolean;
}

function getBaseUrl(request: Request): string {
  return `${request.protocol}://${request.get('host')}`;
}

function respondUnsupportedGrant(res: Response): void {
  res.status(400).json({ error: 'unsupported_grant_type' });
}

function buildRedirectUrl(redirectUri: string, state?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('code', 'mock-code');
  if (state) {
    url.searchParams.set('state', state);
  }
  return url.toString();
}

/**
 * Start a standalone mock server with GitLab API and OAuth endpoints
 */
export async function startStandaloneMockServer(
  config: MockServerConfig = {}
): Promise<MockServerInstance> {
  const { port = 0, apiBasePath = '/api/v4' } = config;

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const branches = new Map<string, BranchState>();
  branches.set('feature/new-feature', { name: 'feature/new-feature', protected: false });

  const apiRouter = express.Router();

  apiRouter.get('/user', (_req, res) => {
    res.json({ id: 1, username: 'mock-user' });
  });

  apiRouter.get('/personal_access_tokens/self', (_req, res) => {
    res.json({ id: 1, active: true });
  });

  apiRouter.get('/projects/:id/repository/branches', (_req, res) => {
    res.json(Array.from(branches.values()));
  });

  apiRouter.put('/projects/:id/repository/branches/:branch/protect', (req, res) => {
    const branchName = decodeURIComponent(req.params.branch);
    const current = branches.get(branchName) ?? { name: branchName, protected: false };
    const updated = { ...current, protected: true };
    branches.set(branchName, updated);
    res.json(updated);
  });

  apiRouter.put('/projects/:id/repository/branches/:branch/unprotect', (req, res) => {
    const branchName = decodeURIComponent(req.params.branch);
    const current = branches.get(branchName) ?? { name: branchName, protected: false };
    const updated = { ...current, protected: false };
    branches.set(branchName, updated);
    res.json(updated);
  });

  app.use(apiBasePath, apiRouter);

  if (config.oauth) {
    app.get('/.well-known/oauth-authorization-server', (req, res) => {
      const baseUrl = getBaseUrl(req);
      res.json({
        authorization_endpoint: `${baseUrl}/oauth/authorize`,
        token_endpoint: `${baseUrl}/oauth/token`,
      });
    });

    app.get('/oauth/authorize', (req, res) => {
      const redirectUri = String(req.query.redirect_uri || '');
      if (!redirectUri) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const state = req.query.state ? String(req.query.state) : undefined;
      res.redirect(302, buildRedirectUrl(redirectUri, state));
    });

    app.post('/oauth/token', (req, res) => {
      const grantType = String(req.body?.grant_type || '');
      if (grantType === 'authorization_code') {
        res.json({
          access_token: config.oauth?.accessToken ?? 'mock-access-token',
          refresh_token: config.oauth?.refreshToken ?? 'mock-refresh-token',
          token_type: 'Bearer',
          expires_in: config.oauth?.expiresIn ?? 3600,
        });
        return;
      }

      if (grantType === 'refresh_token') {
        res.json({
          access_token: `refreshed-${config.oauth?.accessToken ?? 'mock-access-token'}`,
          refresh_token: config.oauth?.refreshToken ?? 'mock-refresh-token',
          token_type: 'Bearer',
          expires_in: config.oauth?.expiresIn ?? 3600,
        });
        return;
      }

      respondUnsupportedGrant(res);
    });
  }

  const server = createServer(app);

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const actualPort = address.port;
      const baseUrl = `http://127.0.0.1:${actualPort}`;

      resolve({
        server,
        port: actualPort,
        gitlabApiUrl: `${baseUrl}${apiBasePath}`,
        oauthUrl: baseUrl,
        stop: () => new Promise<void>((res, rej) => {
          server.close((err) => {
            if (err) rej(err);
            else res();
          });
        }),
      });
    });

    server.on('error', reject);
  });
}

/**
 * Find an available port
 */
export async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}
