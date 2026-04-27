/**
 * Auth header builder for upstream MCP provider requests.
 * Profile-per-upstream model: one token per session.
 */

import type { UpstreamMcpServerConfig } from '../types/profile.js';
import { isValidHttpHeaderName } from '../validation/validation-utils.js';

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

  switch (provider.auth.type) {
    case 'bearer':
      return { Authorization: `Bearer ${token}` };
    case 'custom-header': {
      const headerName = provider.auth.header_name;
      // Defensive: profile load already rejects invalid names, but guard here too
      // to prevent header injection if a misconfigured value somehow bypasses validation.
      if (!headerName || !isValidHttpHeaderName(headerName)) return {};
      return { [headerName]: token };
    }
    case 'query':
      return {};
    default:
      return {};
  }
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
