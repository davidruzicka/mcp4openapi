#!/usr/bin/env node

/**
 * CLI entry point
 * 
 * Why: Reads env vars, initializes server, handles errors gracefully.
 */

import 'dotenv/config';
import { MCPServer } from '../mcp/mcp-server.js';
import { ConsoleLogger, JsonLogger } from './logger.js';
import { OAUTH_PATHS } from './constants.js';
import { applyCliEnvOverrides, parseCliArgs } from './cli-config.js';
import { buildHttpTransportBaseConfig } from '../transport/http-transport-config.js';
import { ProfileRegistry } from '../profile/profile-registry.js';
import { MCPServerManager } from '../mcp/mcp-server-manager.js';
import { getHttpProfileRoutingErrorMessage } from '../profile/startup-validation.js';
import { listProfiles } from '../profile/profile-resolver.js';
import { resolveStartupProfile } from '../profile/startup-profile.js';
import { isProfileAllowed, parseProfileAllowlistConfig } from '../profile/profile-allowlist.js';
import { SSRFValidator } from '../security/ssrf-validator.js';
import { parseOAuthMetadataEndpoints } from '../auth/oauth-metadata.js';

// Bootstrap SSRF checks run before runtime logger setup, so use a no-op logger here.
const bootstrapUrlValidator = new SSRFValidator({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});

/**
 * Fetch OAuth Authorization Server Metadata (RFC 8414)
 * Returns authorization_endpoint and token_endpoint
 */
export async function fetchOAuthMetadata(issuerUrl: string): Promise<{ authorization_endpoint: string; token_endpoint: string } | null> {
  try {
    // Use URL constructor to properly handle trailing slashes
    const metadataUrl = new URL(OAUTH_PATHS.WELL_KNOWN_AUTHORIZATION_SERVER, issuerUrl).toString();

    if (process.env.MCP4_TRUST_BOOTSTRAP_URLS !== 'true') {
      await bootstrapUrlValidator.validate(metadataUrl, {
        allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true',
      });
    }

    const response = await fetch(metadataUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });
    
    if (!response.ok) {
      return null;
    }
    
    return parseOAuthMetadataEndpoints(await response.json());
  } catch {
    return null;
  }
}

/**
 * Derive OAuth issuer from API base URL
 * Example: https://www.gitlab.com/api/v4 -> https://www.gitlab.com
 */
export function deriveIssuerFromBaseUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveHttpHostPort(): { host: string; port: number } {
  const host = process.env.MCP4_HOST || '127.0.0.1';
  const port = parseInt(process.env.MCP4_PORT || '3003', 10);

  if (Number.isNaN(port)) {
    throw new Error(`Invalid MCP4_PORT: ${process.env.MCP4_PORT}`);
  }

  return { host, port };
}

export async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  applyCliEnvOverrides(cliArgs);

  // Create logger early so startup/autodiscovery logs are structured and redacted consistently
  const logFormat = process.env.MCP4_LOG_FORMAT || 'console';
  const logger = logFormat === 'json' ? new JsonLogger() : new ConsoleLogger();

  const profilesDir = process.env.MCP4_PROFILES_DIR;
  if (cliArgs['list-profiles'] === 'true') {
    const profiles = await listProfiles(profilesDir);
    if (profiles.length === 0) {
      console.log('No profiles found.');
      return;
    }
    console.log('Available profiles:');
    for (const profile of profiles) {
      const details: string[] = [];
      if (profile.profileName !== profile.profileId) {
        details.push(`name: ${profile.profileName}`);
      }
      if (profile.profileAliases.length > 0) {
        details.push(`aliases: ${profile.profileAliases.join(', ')}`);
      }
      const detailSuffix = details.length > 0 ? ` (${details.join(', ')})` : '';
      console.log(`- ${profile.profileId}${detailSuffix}`);
    }
    return;
  }

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
        logger.info('OAuth autodiscovery: derived issuer from MCP4_API_BASE_URL', { issuerOrigin });
      }
    }
    
    if (issuer) {
      // Try to fetch OAuth metadata
      // Log origin only, not full URL to avoid logging sensitive paths
      const issuerOrigin = new URL(issuer).origin;
      logger.info('OAuth autodiscovery: fetching metadata', { issuerOrigin });
      const metadata = await fetchOAuthMetadata(issuer);
      
      if (metadata) {
        logger.info('OAuth autodiscovery: successfully discovered OAuth endpoints');
        if (!process.env.MCP4_OAUTH_AUTHORIZATION_URL) {
          process.env.MCP4_OAUTH_AUTHORIZATION_URL = metadata.authorization_endpoint;
          let authorizationEndpointOrigin: string | undefined;
          try {
            authorizationEndpointOrigin = new URL(metadata.authorization_endpoint).origin;
          } catch {
            authorizationEndpointOrigin = undefined;
          }
          logger.info('OAuth autodiscovery: set authorization_endpoint', { authorizationEndpointOrigin });
        }
        if (!process.env.MCP4_OAUTH_TOKEN_URL) {
          process.env.MCP4_OAUTH_TOKEN_URL = metadata.token_endpoint;
          let tokenEndpointOrigin: string | undefined;
          try {
            tokenEndpointOrigin = new URL(metadata.token_endpoint).origin;
          } catch {
            tokenEndpointOrigin = undefined;
          }
          logger.info('OAuth autodiscovery: set token_endpoint', { tokenEndpointOrigin });
        }
      } else {
        // Fallback to standard OAuth paths
        logger.warn('OAuth autodiscovery: metadata fetch failed, using standard OAuth paths', {
          issuerOrigin,
        });
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

  const specPathOverride = process.env.MCP4_OPENAPI_SPEC_PATH;
  const {
    specPath,
    profilePath,
    defaultProfile,
    hasExplicitSpecPath,
  } = await resolveStartupProfile({
    specPathEnv: specPathOverride,
    profilePath: process.env.MCP4_PROFILE_PATH,
    profileId: process.env.MCP4_PROFILE,
    profilesDir,
  });

  const transport = process.env.MCP4_TRANSPORT || 'stdio';
  const httpProfileRoutingEnabled = process.env.MCP4_HTTP_PROFILE_ROUTING === 'true';
  const profileAllowlistConfig = httpProfileRoutingEnabled
    ? parseProfileAllowlistConfig({
      allowNames: process.env.MCP4_ALLOW_PROFILES,
      allowNameRegex: process.env.MCP4_ALLOW_PROFILES_REGEX,
    })
    : null;
  const isDefaultAllowed = defaultProfile ? isProfileAllowed(defaultProfile, profileAllowlistConfig) : false;
  const defaultProfileForRouting = defaultProfile && isDefaultAllowed ? defaultProfile : undefined;
  if (defaultProfile && httpProfileRoutingEnabled && profileAllowlistConfig && !isDefaultAllowed) {
    logger.warn('Default profile excluded by allowlist; /mcp will be disabled', {
      profileId: defaultProfile.profileId,
    });
  }
  const hasDefaultProfile = !!defaultProfileForRouting;
  const hasSpecPath = !!specPath;

  const routingError = getHttpProfileRoutingErrorMessage({
    transport,
    profileRoutingEnabled: httpProfileRoutingEnabled,
    hasDefaultProfile,
    hasSpecPath,
  });
  if (routingError) {
    logger.error(routingError);
    process.exit(1);
  }

  const requiresSpecPath = transport !== 'http' || !httpProfileRoutingEnabled || hasDefaultProfile;
  if (!specPath && requiresSpecPath) {
    logger.error('MCP4_OPENAPI_SPEC_PATH is required. Provide --openapi-spec-path (or MCP4_OPENAPI_SPEC_PATH), or use --profile with openapi_spec_path in the profile.');
    process.exit(1);
  }
  
  try {
    if (transport === 'http' && httpProfileRoutingEnabled) {
      const { host, port } = resolveHttpHostPort();

      const baseConfig = buildHttpTransportBaseConfig(host, port);
      const { HttpTransport } = await import('../transport/http-transport.js');
      const httpTransport = new HttpTransport({
        ...baseConfig,
        profileRoutingEnabled: true,
        defaultProfileId: defaultProfileForRouting?.profileId,
      }, logger);

      const registry = new ProfileRegistry({
        profilesDir,
        defaultProfile: defaultProfileForRouting,
        specPathOverride: hasExplicitSpecPath ? specPathOverride : undefined,
        allowlist: profileAllowlistConfig,
      });
      const manager = new MCPServerManager(registry, logger, httpTransport);

      httpTransport.setProfileContextProvider(async (id) => manager.getProfileContext(id));
      httpTransport.setProfileIndexProvider(async () => registry.listProfilesForIndex());

      httpTransport.setMessageHandler(async (message, sessionId, profileId) => {
        if (!profileId) {
          throw new Error('Profile ID is required for HTTP routing.');
        }
        const server = await manager.getServer(profileId);
        return server.handleHttpMessage(message, sessionId, profileId);
      });

      httpTransport.onSessionDestroyed(async (profileId, sessionId) => {
        try {
          const server = await manager.getServer(profileId);
          server.handleSessionDestroyed(profileId, sessionId);
        } catch (error) {
          logger.error('Session cleanup failed', error as Error, { profileId, sessionId });
        }
      });

      await httpTransport.start();
      logger.info('MCP server running on HTTP', { host, port });

      const shutdown = async (signal: string) => {
        logger.info(`Received ${signal}, shutting down gracefully...`);
        try {
          await httpTransport.stop();
          logger.info('Server stopped successfully');
          process.exit(0);
        } catch (error) {
          logger.error('Error during shutdown', error as Error);
          process.exit(1);
        }
      };

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
      return;
    }

    const server = new MCPServer(logger);
    await server.initialize(specPath!, profilePath);

    if (transport === 'http') {
      const { host, port } = resolveHttpHostPort();

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
