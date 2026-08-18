import type { Logger } from '../core/logger.js';

const DANGEROUS_REDIRECT_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:']);
const SCHEME_ONLY_RULE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function isApprovedUnregisteredClientRedirectUri(
  redirectUri: string,
  approvedRedirects: string[] | undefined,
  logger: Logger,
): boolean {
  if (!Array.isArray(approvedRedirects) || approvedRedirects.length === 0) {
    return false;
  }

  const candidate = parseSafeRedirectUri(redirectUri);
  if (!candidate) {
    return false;
  }

  return approvedRedirects.some((rule) => matchesApprovedRedirectRule(candidate, rule, logger));
}

/**
 * RFC 7591 3.2.2 / RFC 8252 7.1 redirect URI shape check for dynamic client
 * registration. Reuses the shared dangerous-scheme blocklist and loopback set
 * (via {@link parseSafeRedirectUri}) so the registration path does not
 * duplicate the policy: https is allowed, http only for loopback hosts,
 * private-use (custom/native app) schemes are allowed, and javascript:/plain
 * remote http/fragments/credentials/wildcards are rejected.
 */
export function isConformantRegistrationRedirectUri(redirectUri: string): boolean {
  const parsed = parseSafeRedirectUri(redirectUri);
  if (!parsed) {
    return false;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'https:') {
    return true;
  }

  if (protocol === 'http:') {
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return LOOPBACK_HOSTS.has(host);
  }

  // Private-use / custom native app scheme (e.g. cursor://, com.example.app:).
  return true;
}

function matchesApprovedRedirectRule(candidate: URL, rule: string, logger: Logger): boolean {
  const schemeOnly = SCHEME_ONLY_RULE.exec(rule);
  if (schemeOnly) {
    const scheme = schemeOnly[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https') {
      logger.warn('Ignoring insecure scheme-only unregistered OAuth redirect URI rule', { rule });
      return false;
    }
    // Scheme-only approvals are intentionally limited to custom schemes.
    // They do not support wildcard host/path matching; runtime redirect URIs
    // must still be concrete callback URLs without "*" components.
    return candidate.protocol === `${scheme}:`;
  }

  const approved = parseSafeRedirectUri(rule);
  if (!approved) {
    logger.warn('Ignoring invalid approved unregistered OAuth redirect URI rule', { rule });
    return false;
  }

  if (candidate.protocol !== approved.protocol) {
    return false;
  }

  if (candidate.hostname.toLowerCase() !== approved.hostname.toLowerCase()) {
    return false;
  }

  if (!matchesPort(candidate, approved)) {
    return false;
  }

  if (!matchesPathPrefix(candidate, approved)) {
    return false;
  }

  return true;
}

function parseSafeRedirectUri(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (DANGEROUS_REDIRECT_SCHEMES.has(parsed.protocol.toLowerCase())) {
    return null;
  }

  if ((parsed.username && parsed.username.length > 0) || (parsed.password && parsed.password.length > 0)) {
    return null;
  }

  if (parsed.hash && parsed.hash.length > 0) {
    return null;
  }

  if (parsed.hostname.includes('*') || parsed.pathname.includes('*')) {
    return null;
  }

  return parsed;
}

function matchesPort(candidate: URL, approved: URL): boolean {
  if (approved.port.length > 0) {
    return normalizedPort(candidate) === normalizedPort(approved);
  }

  if (LOOPBACK_HOSTS.has(approved.hostname.toLowerCase())) {
    return true;
  }

  return normalizedPort(candidate) === normalizedPort(approved);
}

function matchesPathPrefix(candidate: URL, approved: URL): boolean {
  if (!approved.pathname || approved.pathname === '/') {
    return true;
  }

  return candidate.pathname === approved.pathname
    || candidate.pathname.startsWith(`${approved.pathname.replace(/\/$/, '')}/`);
}

function normalizedPort(url: URL): string {
  if (url.port.length > 0) {
    return url.port;
  }

  if (url.protocol === 'http:') {
    return '80';
  }
  if (url.protocol === 'https:') {
    return '443';
  }

  return '';
}