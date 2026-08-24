/**
 * Browser-facing consent flow for consent-gated profiles.
 *
 * Owns the consent HTML pages (info, acknowledgement form, expired approval),
 * the pending-approval store, and the request-fingerprint/cookie binding that
 * ties a rendered form to the exact OAuth request and the browser that saw it.
 * HttpTransport delegates here so page rendering and approval bookkeeping stay
 * testable without a listening server.
 *
 * The acknowledgement proves neither human presence nor who the user is:
 * identity comes from the OIDC login that follows the redirect.
 */

import crypto from 'crypto';
import type { Response } from 'express';
import type { ConsentGateConfig } from '../types/profile.js';
import { HTTP_STATUS } from '../core/constants.js';
import { ConfigurationError } from '../core/errors.js';
import { escapeHtmlSafe } from '../validation/validation-utils.js';
import { CONSENT_BODY_PLACEHOLDER } from '../profile/consent-gate-validator.js';
import { DANGEROUS_REDIRECT_SCHEMES } from '../auth/unregistered-client-redirect-policy.js';

/** Positive-integer env override with a default; an invalid value fails startup. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw) {
    throw new ConfigurationError(`Invalid ${name}: expected a positive integer`);
  }
  return parsed;
}

// Lifetime of a rendered consent approval and of its browser-binding cookie.
// Tunable via MCP4_CONSENT_APPROVAL_TTL_MS for load shaping; defaults preserved.
export const CONSENT_APPROVAL_TTL_MS = envInt('MCP4_CONSENT_APPROVAL_TTL_MS', 5 * 60 * 1000);
// Upper bound on remembered consumed-approval signatures (same-instance replay guard).
export const CONSUMED_APPROVAL_MAX = envInt('MCP4_CONSENT_CONSUMED_MAX', 10000);
// `__Host-` prefix: browsers only accept it over HTTPS, with Path=/ and no Domain.
export const CONSENT_COOKIE_NAME = '__Host-mcp4_consent';

// Every consent page carries an explicit CSP; the shared renderer makes a
// missing header structurally impossible. The form page additionally pins
// form submission to this origin.
const CONSENT_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
const CONSENT_FORM_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Origin of an https URL, or undefined for anything absent, malformed, or non-https. */
function safeHttpsOrigin(urlValue: string | undefined): string | undefined {
  if (!urlValue) return undefined;
  try {
    const url = new URL(urlValue);
    return url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Translate an ALREADY-VALIDATED OAuth client redirect_uri into a CSP
 * form-action source expression. The redirect policy itself lives in the
 * OAuth layer (client registration / the unregistered-client allowlist) and
 * runs before the approval form renders; this function only maps the value
 * to CSP syntax: http(s) URLs become their origin, custom native-app schemes
 * (cursor://, vscode://, ...) become a scheme source. Dangerous schemes are
 * never reflected, as a cheap second line behind the OAuth-layer validation.
 */
function clientRedirectFormActionSource(urlValue: unknown): string | undefined {
  if (typeof urlValue !== 'string' || !urlValue) return undefined;
  try {
    const url = new URL(urlValue);
    if (DANGEROUS_REDIRECT_SCHEMES.has(url.protocol)) return undefined;
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    return url.protocol;
  } catch {
    return undefined;
  }
}

// OAuth request fields the fingerprint and the re-submitted form are bound to.
const OAUTH_REQUEST_FIELDS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
] as const;

// Version prefix of the stateless approval token embedded in the form.
const APPROVAL_TOKEN_VERSION = 'v1';

/** Extract one cookie value from a raw Cookie header. Returns undefined when absent. */
function parseCookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

/**
 * Digest of the browser id as embedded in the approval token payload. The
 * token must not disclose the cookie value: anyone who sees the rendered
 * form HTML (response-body logs, a saved page) would otherwise be able to
 * forge the Cookie header and the cookie would stop being an independent
 * factor. Only the digest travels; consumption hashes the presented cookie
 * and compares digests.
 */
function browserIdDigest(browserId: string): string {
  return crypto.createHash('sha256').update(browserId, 'utf8').digest('base64url');
}

/**
 * Timing-safe comparison for equal-length strings. A length mismatch returns
 * early: length is not secret here (both values are fixed-size random ids).
 */
function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Single HTML skeleton for all consent pages. `title` must be a trusted
 * literal; `body` must already be escaped by the caller.
 *
 * When the profile configures `consent_gate.template` (full-page HTML authored
 * per deployment), the skeleton is replaced by that template: the server-owned
 * `body` block lands in `{{consent_body}}`, and the cosmetic placeholders below
 * are substituted with escaped values. Security headers (CSP, no-store) are
 * ALWAYS set by this function, template or not, and the template cannot change
 * them - custom markup decorates the page, never the security envelope.
 */
function renderConsentPage(
  res: Response,
  options: { status: number; title: string; body: string; csp: string; gate?: ConsentGateConfig },
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', options.csp);
  // Override the transport-wide `no-referrer`: under no-referrer the browser
  // serializes the approval form POST's Origin header as "null", which origin
  // validation rejects (403 "Origin not allowed") and the consent flow cannot
  // complete. same-origin keeps the referrer internal to the gateway while
  // letting the browser send the real Origin with the form submission.
  res.setHeader('Referrer-Policy', 'same-origin');
  const template = options.gate?.template;
  // Cosmetic placeholders are substituted over the trusted template FIRST; the
  // consent body (which embeds escaped, user-influenced OAuth values) is
  // inserted LAST, so substitution never runs over request-derived content.
  // split/join instead of replaceAll: replacement strings must be literal
  // (no `$&`-style pattern expansion over values or the body).
  const substitute = (input: string, token: string, value: string): string =>
    input.split(token).join(value);
  let html: string;
  if (template) {
    html = substitute(template, '{{rules_version}}', escapeHtmlSafe(options.gate?.rules_version ?? ''));
    html = substitute(html, '{{rules_summary}}', rulesSummary(options.gate as ConsentGateConfig));
    html = substitute(html, '{{education_resource}}', escapeHtmlSafe(options.gate?.education_resource ?? ''));
    html = substitute(html, '{{title}}', options.title);
    html = substitute(html, CONSENT_BODY_PLACEHOLDER, `<!-- server-owned consent block -->${options.body}`);
  } else {
    html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${options.title}</title></head><body><main>${options.body}</main></body></html>`;
  }
  res.status(options.status).type('html').send(html);
}

function educationLink(gate: ConsentGateConfig): string {
  return gate.education_resource
    ? `<p><a href="${escapeHtmlSafe(gate.education_resource)}" rel="noopener noreferrer" target="_blank">Read the usage rules</a></p>`
    : '';
}

function rulesSummary(gate: ConsentGateConfig): string {
  return escapeHtmlSafe(gate.rules_summary ?? 'Access requires accepting the current usage rules.');
}

export class ConsentHttpController {
  /** HMAC key for stateless approval tokens; domain-separated from token envelopes. */
  private readonly approvalHmacKey: Buffer;

  /**
   * Signatures of approvals already consumed by THIS instance (value =
   * payload expiry, for pruning). One-time consumption is exact within an
   * instance and best effort across restarts/replicas: a token that outlives
   * its issuing pod stays bound to one browser (cookie), one OAuth request
   * (fingerprint), and a short TTL, so a cross-instance replay only re-runs
   * the same client's own authorization.
   */
  private readonly consumedApprovals = new Map<string, number>();

  constructor(approvalKey?: Buffer) {
    // Derive a purpose-bound subkey so consent approvals can never be
    // confused with token envelopes built from the same MCP4_OAUTH_KEY.
    // Without shared key material, fall back to a per-instance random key:
    // approvals then only survive within this instance, mirroring the
    // pre-existing MCP4_OAUTH_KEY warning about restart resilience.
    this.approvalHmacKey = crypto
      .createHmac('sha256', approvalKey ?? crypto.randomBytes(32))
      .update('mcp4openapi:consent-approval:v1')
      .digest();
  }

  private signApprovalPayload(payloadB64: string): string {
    return crypto.createHmac('sha256', this.approvalHmacKey).update(payloadB64).digest('base64url');
  }

  private issueApprovalToken(fingerprint: string, browserId: string, expiresAt: number): string {
    // `b` is a digest, never the raw browser id (see browserIdDigest).
    const payloadB64 = Buffer
      .from(JSON.stringify({ f: fingerprint, b: browserIdDigest(browserId), e: expiresAt }))
      .toString('base64url');
    return `${APPROVAL_TOKEN_VERSION}.${payloadB64}.${this.signApprovalPayload(payloadB64)}`;
  }

  /** Digest binding an approval to the complete OAuth request and profile. */
  requestFingerprint(profileId: string, input: Record<string, unknown>): string {
    // JSON array encoding is canonical and unambiguous (fields are length-delimited),
    // so no crafted field value can shift another field's boundary.
    const canonical = JSON.stringify([
      profileId,
      ...OAUTH_REQUEST_FIELDS.map((field) => (typeof input[field] === 'string' ? input[field] : '')),
    ]);
    return crypto.createHash('sha256').update(canonical).digest('base64url');
  }

  /** Human-facing info page served at `/consent`; 404 when the profile is not gated. */
  renderConsentInfo(res: Response, gate: ConsentGateConfig | undefined): void {
    if (!gate?.required) {
      res.status(HTTP_STATUS.NOT_FOUND).send('Consent is not configured for this profile');
      return;
    }
    renderConsentPage(res, {
      status: HTTP_STATUS.OK,
      title: 'Consent required',
      body: `<h1>Consent required</h1><p>${rulesSummary(gate)}</p>${educationLink(gate)}<p>Reconnect this MCP server in your client to start the secure sign-in and consent flow for rules version ${escapeHtmlSafe(gate.rules_version)}.</p>`,
      csp: CONSENT_PAGE_CSP,
      gate,
    });
  }

  /**
   * Render the rules acknowledgement form.
   *
   * The approval is carried STATELESSLY: a signed token (fingerprint,
   * browser id, expiry) is embedded as a hidden form field, so the POST can
   * be consumed by any replica and survives a gateway restart between the
   * form render and the click. A random browser id is set as a `__Host-`
   * cookie and must come back with the POST, so the acknowledgement and the
   * submission demonstrably come from one user agent. Unauthenticated GET
   * floods allocate no server state at all.
   */
  renderApprovalForm(
    res: Response,
    gate: ConsentGateConfig,
    input: Record<string, unknown>,
    fingerprint: string,
    upstreamAuthorizeUrl?: string,
  ): void {
    const browserId = crypto.randomBytes(32).toString('base64url');
    const approvalToken = this.issueApprovalToken(fingerprint, browserId, Date.now() + CONSENT_APPROVAL_TTL_MS);
    res.setHeader(
      'Set-Cookie',
      `${CONSENT_COOKIE_NAME}=${browserId}; Path=/; Max-Age=${CONSENT_APPROVAL_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`,
    );

    const hiddenFields = OAUTH_REQUEST_FIELDS
      .filter((field) => typeof input[field] === 'string')
      .map((field) => `<input type="hidden" name="${field}" value="${escapeHtmlSafe(input[field] as string)}">`)
      .join('')
      // consent_token is deliberately NOT part of the fingerprint fields.
      + `<input type="hidden" name="consent_token" value="${escapeHtmlSafe(approvalToken)}">`;
    // Consent-meaningful texts: part of the rules hash (consent-rules-hash.ts),
    // so editing them invalidates existing grants. `{{rules_version}}` inside
    // the accept label is substituted after escaping.
    const acceptLabel = (gate.labels?.accept
      ? escapeHtmlSafe(gate.labels.accept).split('{{rules_version}}').join(escapeHtmlSafe(gate.rules_version))
      : `I accept rules version ${escapeHtmlSafe(gate.rules_version)}`);
    const submitLabel = escapeHtmlSafe(gate.labels?.submit ?? 'Continue to sign in');
    // CSRF protection: the POST must reproduce the exact request fingerprint the
    // form was rendered for AND present the __Host- cookie set above
    // (consumeApproval checks both). No separate form token is needed.
    // Chrome enforces form-action against EVERY hop of the form submission's
    // redirect chain: the accepted POST answers 302 to the IdP, and after the
    // login callback the chain ends with a redirect back to the OAuth client
    // (e.g. a VS Code loopback listener). A bare form-action 'self' silently
    // aborts the chain in the browser, so allow the upstream authorize origin
    // (https only) and the client redirect origin (https, or loopback http)
    // alongside 'self'.
    const extraOrigins = [
      safeHttpsOrigin(upstreamAuthorizeUrl),
      clientRedirectFormActionSource(input.redirect_uri),
    ].filter((origin): origin is string => origin !== undefined);
    const csp = extraOrigins.length > 0
      ? CONSENT_FORM_CSP.replace("form-action 'self'", `form-action 'self' ${extraOrigins.join(' ')}`)
      : CONSENT_FORM_CSP;
    renderConsentPage(res, {
      status: HTTP_STATUS.OK,
      title: 'Consent required',
      body: `<h1>Consent required</h1><p>${rulesSummary(gate)}</p>${educationLink(gate)}<form method="post">${hiddenFields}<label><input type="checkbox" name="consent_accept" value="yes" required> ${acceptLabel}</label><p><button type="submit">${submitLabel}</button></p></form>`,
      csp,
      gate,
    });
  }

  /**
   * Recoverable dead end for a used, expired, or foreign-browser approval:
   * behind a non-sticky load balancer the GET and POST can land on different
   * replicas, so the page links back into the flow instead of stranding the user.
   */
  renderApprovalExpired(res: Response, retryUrl: string, gate?: ConsentGateConfig): void {
    renderConsentPage(res, {
      status: HTTP_STATUS.BAD_REQUEST,
      title: 'Consent approval expired',
      body: `<h1>Consent approval expired</h1><p>The approval was already used, expired, or was started in a different browser session.</p><p><a href="${escapeHtmlSafe(retryUrl)}">Start the consent flow again</a></p>`,
      csp: CONSENT_PAGE_CSP,
      gate,
    });
  }

  /**
   * Consume an approval token submitted with the acknowledgement form.
   *
   * Expiry-bound and bound to BOTH the complete OAuth request (fingerprint)
   * and the browser that was shown the rules (cookie, compared by digest so
   * the token itself never discloses the cookie value); the HMAC signature
   * proves the form was rendered by a gateway holding the shared key, so the
   * approval survives restarts and works across replicas. One-time
   * consumption is enforced exactly within this instance (see
   * `consumedApprovals`). The acknowledgement proves neither human presence
   * nor who the user is: identity comes from the OIDC login that follows.
   */
  consumeApproval(fingerprint: string, cookieHeader: string | undefined, approvalToken: unknown): boolean {
    if (typeof approvalToken !== 'string') return false;
    const parts = approvalToken.split('.');
    if (parts.length !== 3 || parts[0] !== APPROVAL_TOKEN_VERSION) return false;
    const [, payloadB64, signature] = parts;
    if (!timingSafeEqualString(signature, this.signApprovalPayload(payloadB64))) return false;

    let payload: { f?: unknown; b?: unknown; e?: unknown };
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      return false;
    }
    if (typeof payload.f !== 'string' || typeof payload.b !== 'string' || typeof payload.e !== 'number') return false;
    const now = Date.now();
    if (payload.e <= now) return false;
    if (payload.f !== fingerprint) return false;
    const presented = parseCookieValue(cookieHeader, CONSENT_COOKIE_NAME);
    if (!presented || !timingSafeEqualString(browserIdDigest(presented), payload.b)) return false;

    for (const [sig, expiresAt] of this.consumedApprovals) {
      if (expiresAt <= now) this.consumedApprovals.delete(sig);
    }
    if (this.consumedApprovals.has(signature)) return false;
    // Bounded: overflow evicts the oldest consumed marker; its token is
    // already past its one legitimate use and still TTL/cookie-bound.
    // Residual risk documented in SECURITY.md ("Consumed-approval eviction").
    if (this.consumedApprovals.size >= CONSUMED_APPROVAL_MAX) {
      const oldest = this.consumedApprovals.keys().next().value;
      if (oldest !== undefined) this.consumedApprovals.delete(oldest);
    }
    this.consumedApprovals.set(signature, payload.e);
    return true;
  }
}
