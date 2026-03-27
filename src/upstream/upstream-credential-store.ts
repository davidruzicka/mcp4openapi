/**
 * Per-session credential storage for upstream MCP providers
 *
 * Stores client-supplied tokens keyed by provider name.
 * Tokens are extracted from the X-Upstream-Authorization header at session init
 * and cleared when the session is destroyed.
 */

import type { UpstreamCredentials } from '../types/upstream-connection.js';
import type { UpstreamMcpServerConfig } from '../types/profile.js';

export class UpstreamCredentialStore implements UpstreamCredentials {
  private readonly tokens = new Map<string, string>();

  setToken(providerName: string, token: string): void {
    this.tokens.set(providerName, token);
  }

  getToken(providerName: string): string | undefined {
    return this.tokens.get(providerName);
  }

  hasCredentials(providerName: string): boolean {
    return this.tokens.has(providerName);
  }

  clear(): void {
    this.tokens.clear();
  }
}

/**
 * Build HTTP auth headers for an upstream provider request.
 *
 * - bearer: { Authorization: 'Bearer <token>' }
 * - custom-header: { [header_name]: token }
 * - query: empty (query auth handled at URL level by caller)
 * - no auth or no token: empty
 */
export function buildAuthHeaders(
  provider: UpstreamMcpServerConfig,
  credentials: UpstreamCredentials,
): Record<string, string> {
  if (!provider.auth) return {};

  const token = credentials.getToken(provider.name);
  if (!token) return {};

  const AUTH_HEADER_BUILDERS: Record<string, (tok: string) => Record<string, string>> = {
    bearer: (tok) => ({ Authorization: `Bearer ${tok}` }),
    'custom-header': (tok) => {
      const headerName = provider.auth?.header_name;
      return headerName ? { [headerName]: tok } : {};
    },
    query: () => ({}),
  };

  const builder = AUTH_HEADER_BUILDERS[provider.auth.type];
  return builder ? builder(token) : {};
}
