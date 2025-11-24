import http from 'http';
import crypto from 'crypto';

// PKCE helper functions
function base64URLEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

function generateCodeVerifier() {
  return base64URLEncode(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier) {
  return base64URLEncode(sha256(verifier));
}

function waitForServer(url, timeout = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        if (res.statusCode === 200 || res.statusCode === 404) {
          resolve();
        } else {
          setTimeout(check, 1000);
        }
      });
      
      req.on('error', () => {
        if (Date.now() - start > timeout) {
          reject(new Error(`Timeout waiting for ${url}`));
        } else {
          setTimeout(check, 1000);
        }
      });
      
      req.end();
    };
    check();
  });
}

async function runTest() {
  // Read environment variables (set by Docker Compose or default to localhost)
  const mcpServerUrl = process.env.MCP_SERVER_URL || 'http://localhost:3003';
  const mockOAuthUrl = process.env.MOCK_OAUTH_URL || 'http://localhost:4000';
  
  console.log(`MCP Server URL: ${mcpServerUrl}`);
  console.log(`Mock OAuth URL: ${mockOAuthUrl}`);
  console.log('Waiting for services...');
  
  try {
    await waitForServer(mockOAuthUrl); 
    await waitForServer(`${mcpServerUrl}/health`);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }

  console.log('Services up. Starting OAuth flow test with PKCE...');

  // Generate PKCE parameters
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  console.log(`Generated PKCE: verifier=${codeVerifier.substring(0, 10)}..., challenge=${codeChallenge.substring(0, 10)}...`);

  // Use correct hostnames based on environment
  const redirectUri = process.env.MCP_SERVER_URL 
    ? `${mcpServerUrl}/oauth/callback`
    : 'http://localhost:3003/oauth/callback';
  
  const authUrl = `${mcpServerUrl}/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent(redirectUri)}&scope=api&state=test-state&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256`;
  
  console.log(`Requesting authorization...`);
  
  // Step 1: Hit MCP Authorize -> Redirects to Mock OAuth
  let res = await fetch(authUrl, { redirect: 'manual' });
  console.log(`Step 1 status: ${res.status}`);
  
  if (res.status !== 302) {
    console.error('Expected 302 redirect to Mock OAuth');
    console.log('Body:', await res.text());
    process.exit(1);
  }
  
  const mockAuthUrl = res.headers.get('location');
  console.log(`Redirected to: ${mockAuthUrl}`);
  
  // Step 2: Hit Mock OAuth -> Redirects back to MCP Callback with code
  res = await fetch(mockAuthUrl, { redirect: 'manual' });
  console.log(`Step 2 status: ${res.status}`);
  
  if (res.status !== 302) {
    console.error('Expected 302 redirect from Mock OAuth');
    console.log('Body:', await res.text());
    process.exit(1);
  }
  
  const callbackUrl = res.headers.get('location');
  console.log(`Redirected to: ${callbackUrl}`);
  
  if (!callbackUrl.includes('code=')) {
     console.error('Callback URL missing code');
     process.exit(1);
  }

  // Step 3: Hit MCP Callback -> MCP Server exchanges code for token
  // This should complete the flow and redirect to client
  res = await fetch(callbackUrl, { redirect: 'manual' });
  console.log(`Step 3 status: ${res.status}`);
  
  if (res.status === 302) {
    const finalRedirect = res.headers.get('location');
    console.log(`Final redirect: ${finalRedirect}`);
    
    if (finalRedirect && finalRedirect.includes('code=')) {
      console.log('✅ OAuth Flow Successful!');
      console.log('Internal authorization code received.');
      process.exit(0);
    } else {
      console.error('Final redirect missing authorization code');
      process.exit(1);
    }
  } else {
    const text = await res.text();
    console.error(`OAuth Flow Failed at callback step. Status: ${res.status}`);
    console.log(text);
    process.exit(1);
  }
}

runTest();
