/**
 * Extract upstream credentials from HTTP headers during session init
 *
 * Parses the X-Upstream-Authorization header to extract per-provider tokens.
 * Token values are NEVER logged - only provider names appear in debug output.
 */

/** Header name (lowercase for Express req.headers access) */
export const UPSTREAM_AUTH_HEADER = 'x-upstream-authorization';

/**
 * Extract upstream credentials from HTTP request headers.
 *
 * Header format: `X-Upstream-Authorization: provider-name=token[,provider2=token2]`
 * - Comma-separated entries for multiple providers
 * - Splits on first `=` only (handles base64 tokens with trailing `=`)
 * - Only includes providers present in allowedProviders
 *
 * @returns Map of provider name to token, or undefined if no valid credentials found
 */
export function extractUpstreamCredentials(
  headers: Record<string, string | string[] | undefined>,
  allowedProviders: string[],
): Map<string, string> | undefined {
  const rawValue = headers[UPSTREAM_AUTH_HEADER];
  if (!rawValue) return undefined;

  const headerValue = Array.isArray(rawValue) ? rawValue.join(',') : rawValue;
  if (!headerValue.trim()) return undefined;

  const allowedSet = new Set(allowedProviders);
  const result = new Map<string, string>();

  const entries = headerValue.split(',');
  for (const entry of entries) {
    const eqIndex = entry.indexOf('=');
    if (eqIndex === -1) continue;

    const providerName = entry.slice(0, eqIndex).trim();
    const token = entry.slice(eqIndex + 1).trim();

    if (!providerName || !token) continue;
    if (!allowedSet.has(providerName)) continue;

    result.set(providerName, token);
  }

  return result.size > 0 ? result : undefined;
}
