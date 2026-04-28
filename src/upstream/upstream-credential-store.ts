import type { AuthTokenConfig, UpstreamMcpServerConfig } from '../types/profile.js';
import type { UpstreamAuthStrategy } from '../types/upstream-connection.js';
import { isValidHttpHeaderName } from '../validation/validation-utils.js';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactLiteral(token: string, message: string): string {
  if (!token) return message;
  return message.replace(new RegExp(escapeRegex(token), 'g'), '[REDACTED]');
}

const NOOP_STRATEGY: UpstreamAuthStrategy = {
  buildHeaders: () => ({}),
  buildUrl: (url) => url,
  sanitize: (_, msg) => msg,
};

/**
 * Build an auth strategy for bearer/query/custom-header token configs.
 * Accepts any AuthTokenConfig-shaped value — works for both UpstreamMcpAuthConfig
 * and the bearer/query/custom-header subset of AuthInterceptor.
 *
 * Contextual regexes (header name, query param) are pre-compiled in the closure.
 * Token regex is compiled per sanitize() call because the token is not known at strategy creation.
 */
export function createAuthStrategy(auth: AuthTokenConfig | undefined): UpstreamAuthStrategy {
  if (!auth) return NOOP_STRATEGY;

  switch (auth.type) {
    case 'bearer':
      return {
        buildHeaders: (tok) => ({ Authorization: `Bearer ${tok}` }),
        buildUrl: (url) => url,
        sanitize: redactLiteral,
      };

    case 'custom-header': {
      const headerName = auth.header_name;
      // Defensive: profile load already rejects invalid names, but guard here too
      // to prevent header injection if a misconfigured value somehow bypasses validation.
      if (!headerName || !isValidHttpHeaderName(headerName)) return NOOP_STRATEGY;
      const contextualRe = new RegExp(`(${escapeRegex(headerName)}:\\s*)\\S+`, 'gi');
      return {
        buildHeaders: (tok) => ({ [headerName]: tok }),
        buildUrl: (url) => url,
        sanitize: (tok, msg) => redactLiteral(tok, msg).replace(contextualRe, '$1[REDACTED]'),
      };
    }

    case 'query': {
      const param = auth.query_param;
      if (!param) return NOOP_STRATEGY;
      const contextualRe = new RegExp(`([?&]${escapeRegex(param)}=)[^&\\s]+`, 'gi');
      return {
        buildHeaders: () => ({}),
        buildUrl: (url, tok) => {
          const result = new URL(url.toString());
          result.searchParams.set(param, tok);
          return result;
        },
        sanitize: (tok, msg) => redactLiteral(tok, msg).replace(contextualRe, '$1[REDACTED]'),
      };
    }

    default:
      return NOOP_STRATEGY;
  }
}

// Backward-compat wrappers for callers that don't need the strategy object directly.
export function buildAuthHeaders(
  provider: UpstreamMcpServerConfig,
  token: string | undefined,
): Record<string, string> {
  if (!provider.auth || !token) return {};
  return createAuthStrategy(provider.auth).buildHeaders(token);
}

export function buildAuthUrl(
  provider: UpstreamMcpServerConfig,
  url: URL,
  token: string | undefined,
): URL {
  if (!provider.auth || !token) return url;
  return createAuthStrategy(provider.auth).buildUrl(url, token);
}
