#!/usr/bin/env node

/**
 * CLI entry point
 * 
 * Why: Reads env vars, initializes server, handles errors gracefully.
 */

import 'dotenv/config';
import { MCPServer } from './mcp-server.js';
import { ConsoleLogger, JsonLogger } from './logger.js';
import { OAUTH_PATHS } from './constants.js';

/**
 * Fetch OAuth Authorization Server Metadata (RFC 8414)
 * Returns authorization_endpoint and token_endpoint
 */
async function fetchOAuthMetadata(issuerUrl: string): Promise<{ authorization_endpoint: string; token_endpoint: string } | null> {
  try {
    // Use URL constructor to properly handle trailing slashes
    const metadataUrl = new URL(OAUTH_PATHS.WELL_KNOWN_AUTHORIZATION_SERVER, issuerUrl).toString();
    const response = await fetch(metadataUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });
    
    if (!response.ok) {
      return null;
    }
    
    const metadata = await response.json() as any;
    return {
      authorization_endpoint: metadata.authorization_endpoint,
      token_endpoint: metadata.token_endpoint,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Derive OAuth issuer from API base URL
 * Example: https://www.gitlab.com/api/v4 -> https://www.gitlab.com
 */
function deriveIssuerFromBaseUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    return url.origin;
  } catch {
    return null;
  }
}

async function main() {
  // OAuth Configuration Priority:
  // 1. Explicit env vars (MCP4_OAUTH_AUTHORIZATION_URL, MCP4_OAUTH_TOKEN_URL)
  // 2. Explicit issuer (MCP4_OAUTH_ISSUER)
  // 3. Autodiscovery from MCP4_API_BASE_URL
  
  const hasOAuthCredentials = 
    process.env.MCP4_OAUTH_CLIENT_ID && 
    process.env.MCP4_OAUTH_CLIENT_SECRET && 
    process.env.MCP4_OAUTH_REDIRECT_URI;

  const hasExplicitOAuthUrls = 
    process.env.MCP4_OAUTH_AUTHORIZATION_URL && 
    process.env.MCP4_OAUTH_TOKEN_URL;

  if (hasOAuthCredentials && !hasExplicitOAuthUrls) {
    // Try OAuth autodiscovery
    let issuer: string | undefined = process.env.MCP4_OAUTH_ISSUER;
    
    // If no explicit issuer, try to derive from API base URL
    if (!issuer && process.env.MCP4_API_BASE_URL) {
      const derivedIssuer = deriveIssuerFromBaseUrl(process.env.MCP4_API_BASE_URL);
      if (derivedIssuer) {
        issuer = derivedIssuer;
        // Log origin only, not full URL to avoid logging sensitive paths
        const issuerOrigin = new URL(derivedIssuer).origin;
        console.log(`[OAuth Autodiscovery] Derived issuer from MCP4_API_BASE_URL: ${issuerOrigin}`);
      }
    }
    
    if (issuer) {
      // Try to fetch OAuth metadata
      // Log origin only, not full URL to avoid logging sensitive paths
      const issuerOrigin = new URL(issuer).origin;
      console.log(`[OAuth Autodiscovery] Fetching metadata from ${issuerOrigin}/.well-known/oauth-authorization-server`);
      const metadata = await fetchOAuthMetadata(issuer);
      
      if (metadata) {
        console.log(`[OAuth Autodiscovery] Successfully discovered OAuth endpoints`);
        if (!process.env.MCP4_OAUTH_AUTHORIZATION_URL) {
          process.env.MCP4_OAUTH_AUTHORIZATION_URL = metadata.authorization_endpoint;
          console.log(`[OAuth Autodiscovery] authorization_endpoint: ${metadata.authorization_endpoint}`);
        }
        if (!process.env.MCP4_OAUTH_TOKEN_URL) {
          process.env.MCP4_OAUTH_TOKEN_URL = metadata.token_endpoint;
          console.log(`[OAuth Autodiscovery] token_endpoint: ${metadata.token_endpoint}`);
        }
      } else {
        // Fallback to standard OAuth paths
        console.log(`[OAuth Autodiscovery] Metadata fetch failed, using standard OAuth paths`);
        if (!process.env.MCP4_OAUTH_AUTHORIZATION_URL) {
          process.env.MCP4_OAUTH_AUTHORIZATION_URL = `${issuer}/oauth/authorize`;
        }
        if (!process.env.MCP4_OAUTH_TOKEN_URL) {
          process.env.MCP4_OAUTH_TOKEN_URL = `${issuer}/oauth/token`;
        }
      }
    }
  } else if (process.env.MCP4_OAUTH_ISSUER && !hasExplicitOAuthUrls) {
    // Legacy behavior: derive from explicit issuer
    const issuer = process.env.MCP4_OAUTH_ISSUER;
    if (!process.env.MCP4_OAUTH_AUTHORIZATION_URL) {
      process.env.MCP4_OAUTH_AUTHORIZATION_URL = `${issuer}/oauth/authorize`;
    }
    if (!process.env.MCP4_OAUTH_TOKEN_URL) {
      process.env.MCP4_OAUTH_TOKEN_URL = `${issuer}/oauth/token`;
    }
  }

  // Create logger based on env
  const logFormat = process.env.MCP4_LOG_FORMAT || 'console';
  const logger = logFormat === 'json'
    ? new JsonLogger()
    : new ConsoleLogger();

  const specPath = process.env.MCP4_OPENAPI_SPEC_PATH;
  if (!specPath) {
    logger.error('MCP4_OPENAPI_SPEC_PATH environment variable is required');
    process.exit(1);
  }

  const profilePath = process.env.MCP4_PROFILE_PATH;
  const transport = process.env.MCP4_TRANSPORT || 'stdio';
  
  try {
    const server = new MCPServer(logger);
    await server.initialize(specPath, profilePath);

    if (transport === 'http') {
      const host = process.env.MCP4_HOST || '127.0.0.1';
      const port = parseInt(process.env.MCP4_PORT || '3003', 10);

      if (isNaN(port)) {
        throw new Error(`Invalid MCP4_PORT: ${process.env.MCP4_PORT}`);
      }

      await server.runHttp(host, port);
    } else {
      await server.runStdio();
    }

    // Graceful shutdown handlers
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      try {
        await server.stop();
        logger.info('Server stopped successfully');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown', error as Error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('Fatal error', error as Error);
    process.exit(1);
  }
}

main();

