# Integration Tests

## OAuth Flow Test with Docker Compose

Tests the complete OAuth 2.0 flow with PKCE using Docker Compose.

### Architecture

```
┌─────────────┐       ┌─────────────┐       ┌─────────────┐
│ test-runner │──────▶│ mcp-server  │──────▶│ mock-oauth  │
│  (Node.js)  │       │   (OAuth)   │       │  (Mock IdP) │
└─────────────┘       └─────────────┘       └─────────────┘
      │                      │                      │
      └──────────────────────┴──────────────────────┘
            All run in Docker network
```

### Running Tests

#### Option 1: Inside Docker (Recommended)

```bash
cd tests/integration
docker-compose -f docker-compose.test.yml up --build test-runner
```

The test runner runs inside Docker and can resolve `mock-oauth` and `mcp-server` hostnames.

#### Option 2: From Host (Manual)

```bash
cd tests/integration
docker-compose -f docker-compose.test.yml up -d mcp-server mock-oauth
# Wait for services to start
sleep 5
# Run test from host (uses localhost URLs)
node run_test.js
# Cleanup
docker-compose -f docker-compose.test.yml down
```

### Environment Variables

The test script supports both environments:

- **Inside Docker**: Uses `MCP_SERVER_URL=http://mcp-server:3003` and `MOCK_OAUTH_URL=http://mock-oauth:4000`
- **From Host**: Uses `http://localhost:3003` and `http://localhost:4000` (default)

### What the Test Does

1. Generates PKCE parameters (code verifier and challenge)
2. Requests authorization from MCP server
3. Follows redirect to Mock OAuth provider
4. Mock OAuth redirects back with authorization code
5. Exchanges code for access token
6. Verifies PKCE code challenge

### Expected Output

```
MCP Server URL: http://mcp-server:3003
Mock OAuth URL: http://mock-oauth:4000
Waiting for services...
Services up. Starting OAuth flow test with PKCE...
Generated PKCE: verifier=..., challenge=...
Requesting authorization...
Step 1 status: 302
Redirected to: http://mock-oauth:4000/oauth/authorize?...
Step 2 status: 302
Redirected to: http://mcp-server:3003/oauth/callback?code=...
Step 3 status: 200
Token response: {"access_token":"test-access-token","token_type":"Bearer"}
✅ OAuth flow with PKCE completed successfully!
```

### Troubleshooting

#### `ENOTFOUND mock-oauth`

**Cause**: Test is running from host but trying to access Docker network hostname.

**Fix**: Run test inside Docker using `docker-compose up test-runner`.

#### Services not ready

**Cause**: Services haven't started yet.

**Fix**: Increase wait timeout or add healthchecks to docker-compose.yml.



