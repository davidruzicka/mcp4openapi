const http = require('http');
const url = require('url');
const querystring = require('querystring');

const PORT = 4000;
const ACCESS_TOKEN = 'mock-access-token-12345';

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const { pathname, query } = parsedUrl;

  console.log(`${req.method} ${pathname}`);

  // Discovery endpoint
  if (req.method === 'GET' && pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        authorization_endpoint: `http://localhost:${PORT}/oauth/authorize`,
        token_endpoint: `http://localhost:${PORT}/oauth/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code']
      }));
      return;
  }

  if (req.method === 'GET' && pathname === '/oauth/authorize') {
    const { redirect_uri, state } = query;
    if (!redirect_uri) {
      res.writeHead(400);
      res.end('Missing redirect_uri');
      return;
    }

    const code = 'mock-code-' + Math.random().toString(36).substring(7);
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);

    console.log(`Redirecting to: ${redirectUrl.toString()}`);
    res.writeHead(302, { Location: redirectUrl.toString() });
    res.end();
    return;
  }

  if (req.method === 'POST' && pathname === '/oauth/token') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      console.log('Token request body:', body);
      const params = querystring.parse(body);
      
      // Simple validation
      if (params.grant_type !== 'authorization_code') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
          return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: ACCESS_TOKEN,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'api'
      }));
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mock OAuth Server running on port ${PORT}`);
});

