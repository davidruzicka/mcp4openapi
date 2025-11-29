/**
 * Standalone mock server for E2E tests
 * 
 * Why: Creates a real HTTP server from MSW handlers for process-based testing.
 * The MCP server runs as a separate process and needs actual network endpoints.
 */

import { createServer as createMswServer } from '@mswjs/http-middleware';
import { Server } from 'http';
import { AddressInfo } from 'net';
import {
  createGitLabHandlers,
  createOAuthHandlers,
  OAuthConfig,
  DEFAULT_BASE_URL,
} from '../../../src/testing/mock-gitlab-server.js';

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

/**
 * Start a standalone mock server with GitLab API and OAuth endpoints
 */
export async function startStandaloneMockServer(
  config: MockServerConfig = {}
): Promise<MockServerInstance> {
  const { port = 0, apiBasePath = '/api/v4' } = config;

  // We'll determine the actual URL after the server starts
  const tempBaseUrl = `http://localhost${apiBasePath}`;
  
  // Create handlers - we'll need to recreate them with the actual URL
  const gitlabHandlers = createGitLabHandlers(tempBaseUrl);
  
  // Create MSW-based Express server
  const httpServer = createMswServer(...gitlabHandlers);

  return new Promise((resolve, reject) => {
    const server = httpServer.listen(port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const actualPort = address.port;
      const baseUrl = `http://127.0.0.1:${actualPort}`;

      // Now recreate handlers with correct URLs
      const actualGitlabUrl = `${baseUrl}${apiBasePath}`;
      const actualGitlabHandlers = createGitLabHandlers(actualGitlabUrl);
      
      let oauthHandlers: ReturnType<typeof createOAuthHandlers> = [];
      if (config.oauth) {
        const oauthConfig: OAuthConfig = {
          ...config.oauth,
          oauthBaseUrl: baseUrl,
        };
        oauthHandlers = createOAuthHandlers(oauthConfig);
      }

      // Close the initial server and start a new one with correct handlers
      server.close(() => {
        const finalServer = createMswServer(...oauthHandlers, ...actualGitlabHandlers);
        
        const newServer = finalServer.listen(actualPort, '127.0.0.1', () => {
          resolve({
            server: newServer,
            port: actualPort,
            gitlabApiUrl: actualGitlabUrl,
            oauthUrl: baseUrl,
            stop: () => new Promise<void>((res, rej) => {
              newServer.close((err) => {
                if (err) rej(err);
                else res();
              });
            }),
          });
        });

        newServer.on('error', reject);
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
    const server = require('net').createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}
