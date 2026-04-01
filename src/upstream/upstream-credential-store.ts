/**
 * Auth header builder for upstream MCP provider requests.
 * Profile-per-upstream model: one token per session.
 */

import type { UpstreamMcpServerConfig } from '../types/profile.js';

/**
 * Build HTTP auth headers for an upstream provider request.
 *
 * - bearer: { Authorization: 'Bearer <token>' }
 * - custom-header: { [header_name]: token }
 * - query: empty (token appended to URL via buildAuthUrl instead)
 * - no auth or no token: empty
 */
export function buildAuthHeaders(
  provider: UpstreamMcpServerConfig,
  token: string | undefined,
): Record<string, string> {
  if (!provider.auth) return {};
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

/**
 * Return a URL with the query auth token appended for `auth.type: "query"` providers.
 * For all other auth types the original URL is returned unchanged.
 *
 * Callers must use this alongside buildAuthHeaders so that query-auth providers
 * actually receive their credentials.
 */
export function buildAuthUrl(
  provider: UpstreamMcpServerConfig,
  url: URL,
  token: string | undefined,
): URL {
  if (!provider.auth || provider.auth.type !== 'query' || !token) {
    return url;
  }
  const paramName = provider.auth.query_param;
  if (!paramName) return url;
  const result = new URL(url.toString());
  result.searchParams.set(paramName, token);
  return result;
}
