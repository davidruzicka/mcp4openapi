/**
 * E2E tests for enterprise-managed authentication.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { McpProcess } from './utils/mcp-process.js';
import { describeIfListen } from './utils/listen-support.js';
import { getAvailablePort } from './utils/mock-server.js';

async function startJwksServer(jwks: Record<string, unknown>): Promise<{ server: Server; issuerUrl: string; stop: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === '/jwks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwks] }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  const address = server.address() as AddressInfo;
  const issuerUrl = `http://127.0.0.1:${address.port}`;

  return {
    server,
    issuerUrl,
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
  };
}

describeIfListen('E2E: enterprise authentication', () => {
  let mcp: McpProcess | undefined;
  let jwksServer: { stop: () => Promise<void>; issuerUrl: string } | undefined;
  let privateKey: CryptoKey;
  let profilePath: string;

  const openapiSpecPath = path.resolve(process.cwd(), 'profiles/gitlab/openapi.yaml');
  const enterpriseResource = 'https://enterprise.example/mcp';

  beforeAll(async () => {
    const { privateKey: generatedPrivateKey, publicKey } = await generateKeyPair('RS256');
    privateKey = generatedPrivateKey;

    const jwk = await exportJWK(publicKey);
    jwk.kid = 'enterprise-key-1';
    jwk.alg = 'RS256';
    jwk.use = 'sig';

    jwksServer = await startJwksServer(jwk as Record<string, unknown>);

    profilePath = `/tmp/mcp4openapi-enterprise-e2e-${Date.now()}.json`;
    await fs.writeFile(
      profilePath,
      JSON.stringify({
        profile_name: 'enterprise-e2e',
        description: 'Minimal profile for enterprise auth e2e coverage.',
        tools: [
          {
            name: 'manage_groups',
            description: 'List GitLab groups.',
            operations: {
              list: 'getApiV4Groups',
            },
            parameters: {
              action: {
                type: 'string',
                description: 'Action to perform.',
                enum: ['list'],
                required: true,
              },
            },
          },
        ],
        enterprise_authorization: {
          enabled: true,
          mode: 'required',
          resource: enterpriseResource,
          issuer: {
            issuer: jwksServer.issuerUrl,
            jwks_uri: `${jwksServer.issuerUrl}/jwks`,
            allowed_algs: ['RS256'],
          },
          token_exchange: {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            required_typ: ['at+jwt'],
            required_claims: ['sub'],
          },
          access_policy: {
            scopes_supported: ['api'],
            default_scopes: ['api'],
          },
        },
      }),
      'utf-8'
    );
  }, 30000);

  afterEach(async () => {
    await mcp?.stop();
    mcp = undefined;
  });

  afterAll(async () => {
    await mcp?.stop();
    await jwksServer?.stop();
    if (profilePath) {
      await fs.rm(profilePath, { force: true });
    }
  });

  async function startEnterpriseServer(): Promise<number> {
    const httpPort = await getAvailablePort();
    mcp = new McpProcess({
      transport: 'http',
      openapiSpecPath,
      profilePath,
      httpPort,
      env: {
        NODE_ENV: 'test',
        MCP4_SSRF_ALLOW_PRIVATE_NETWORK: 'true',
      },
    });

    await mcp.start();
    return httpPort;
  }

  async function createAssertion(jti: string): Promise<string> {
    return new SignJWT({ sub: 'enterprise-user', scope: 'api', client_id: 'enterprise-client' })
      .setProtectedHeader({ alg: 'RS256', kid: 'enterprise-key-1', typ: 'at+jwt' })
      .setIssuer(jwksServer!.issuerUrl)
      .setAudience(enterpriseResource)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti(jti)
      .sign(privateKey);
  }

  it('requires enterprise bearer token during HTTP initialization', async () => {
    const httpPort = await startEnterpriseServer();

    const response = await fetch(`http://127.0.0.1:${httpPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'enterprise-e2e', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');

    const body = await response.json();
    expect(body.message).toBe('Enterprise authorization required');
  }, 20000);

  it('exchanges jwt bearer assertion for opaque token and initializes session', async () => {
    const httpPort = await startEnterpriseServer();
    const assertion = await createAssertion('enterprise-e2e-jti-1');

    const tokenResponse = await fetch(`http://127.0.0.1:${httpPort}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
        client_id: 'enterprise-client',
      }),
    });

    expect(tokenResponse.status).toBe(200);
    const tokenBody = await tokenResponse.json() as { access_token: string; token_type: string; scope?: string };
    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.access_token).not.toContain('.');
    expect(tokenBody.scope).toBe('api');

    const initializeResponse = await fetch(`http://127.0.0.1:${httpPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenBody.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'enterprise-e2e', version: '1.0.0' },
        },
      }),
    });

    expect(initializeResponse.status).toBe(200);
    const sessionId = initializeResponse.headers.get('Mcp-Session-Id');
    expect(sessionId).toBeTruthy();

    const listToolsResponse = await fetch(`http://127.0.0.1:${httpPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenBody.access_token}`,
        'Mcp-Session-Id': sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(listToolsResponse.status).toBe(200);
    const listToolsBody = await listToolsResponse.json() as { result?: { tools?: Array<{ name: string }> } };
    expect(listToolsBody.result?.tools?.map(tool => tool.name)).toContain('manage_groups');
  }, 20000);
});
