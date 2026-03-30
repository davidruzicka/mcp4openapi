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
 * - query: empty (query auth handled at URL level by caller)
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
