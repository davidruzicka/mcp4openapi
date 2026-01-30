
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { MCPServer } from '../mcp/mcp-server.js';
import path from 'path';
import { HttpTransport } from '../transport/http-transport.js';
import { describeIfListen } from './listen-support.js';

describeIfListen('MCPServer OAuth Integration', () => {
  let server: MCPServer;
  let app: any;
  const originalEnv = process.env;

  beforeAll(async () => {
    process.env = { ...originalEnv };
    process.env.GITLAB_OAUTH_CLIENT_ID = 'test-client';
    process.env.GITLAB_OAUTH_CLIENT_SECRET = 'test-secret';
    process.env.GITLAB_OAUTH_ISSUER = 'https://gitlab.com';
    process.env.GITLAB_OAUTH_AUTHORIZATION_URL = 'https://gitlab.com/oauth/authorize';
    process.env.GITLAB_OAUTH_TOKEN_URL = 'https://gitlab.com/oauth/token';
    process.env.GITLAB_OAUTH_REDIRECT_URI = 'http://localhost:3000/callback';
    process.env.GITLAB_OAUTH_SCOPES = 'api';

    server = new MCPServer();
    
    const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
    const profilePath = path.join(process.cwd(), 'profiles/gitlab/developer-profile-oauth.json');
    
    await server.initialize(specPath, profilePath);
    await server.runHttp('127.0.0.1', 0);
    
    const transport = (server as any).httpTransport as HttpTransport;
    app = (transport as any).app;
  });

  afterAll(async () => {
    const transport = (server as any).httpTransport as HttpTransport;
    if (transport) {
      await transport.stop();
    }
    process.env = originalEnv;
  });

  it('should require OAuth for initialization', async () => {
    const response = await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      });

    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBeDefined();
    expect(response.body.error).toBe('Unauthorized');
    expect(response.body.message).toContain('Authentication required');
  });
});
