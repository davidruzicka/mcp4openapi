import {
  ConfigurationError,
  SessionCookieBackoffError,
  SessionCookieExpiredError,
  SessionCookieLoginError,
  SessionCookieMissingError,
} from '../core/errors.js';
import { TIMEOUTS } from '../core/constants.js';
import type { Logger } from '../core/logger.js';
import { SSRFValidator } from '../security/ssrf-validator.js';
import type { SessionCookieConfig } from '../types/profile.js';
import { isHostnameAllowed, isSafePropertyName } from '../validation/validation-utils.js';
import type { AuthRuntimeProvider } from './auth-runtime.js';
import type { AuthCredentials, RequestContext, ResponseContext } from './interceptors.js';

export interface SessionCookieEntry {
  name: string;
  value: string;
  expiresAt?: number;
}

function getHeaderValueCaseInsensitive(headers: Record<string, string>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

function getSetCookieHeader(headers: Headers): string | undefined {
  const extendedHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extendedHeaders.getSetCookie === 'function') {
    const values = extendedHeaders.getSetCookie();
    if (values.length > 0) {
      return values.join(', ');
    }
  }

  return headers.get('set-cookie') ?? undefined;
}

export class SetCookieParser {
  static splitHeader(headerValue: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inExpires = false;

    for (let index = 0; index < headerValue.length; index += 1) {
      const char = headerValue[index];

      if (!inExpires && headerValue.slice(index, index + 8).toLowerCase() === 'expires=') {
        inExpires = true;
      }

      if (char === ',') {
        if (inExpires) {
          const remainder = headerValue.slice(index + 1);
          if (!/^\s*[^=;,]+=\s*[^;,]/.test(remainder)) {
            current += char;
            continue;
          }
          inExpires = false;
        }

        const trimmed = current.trim();
        if (trimmed) {
          parts.push(trimmed);
        }
        current = '';
        continue;
      }

      if (char === ';' && inExpires) {
        inExpires = false;
      }

      current += char;
    }

    const trimmed = current.trim();
    if (trimmed) {
      parts.push(trimmed);
    }

    return parts;
  }

  static parseHeader(headerValue: string): SessionCookieEntry[] {
    return this.splitHeader(headerValue)
      .map((cookieValue) => this.parseCookie(cookieValue))
      .filter((cookie): cookie is SessionCookieEntry => cookie !== null);
  }

  private static parseCookie(cookieValue: string): SessionCookieEntry | null {
    const parts = cookieValue.split(';').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) {
      return null;
    }

    const nameValue = parts[0];
    const separatorIndex = nameValue.indexOf('=');
    if (separatorIndex <= 0) {
      return null;
    }

    const name = nameValue.slice(0, separatorIndex).trim();
    const value = nameValue.slice(separatorIndex + 1).trim();
    if (!name || !value) {
      return null;
    }

    let expiresAt: number | undefined;
    for (const attribute of parts.slice(1)) {
      const attributeSeparatorIndex = attribute.indexOf('=');
      const attributeName = (attributeSeparatorIndex === -1 ? attribute : attribute.slice(0, attributeSeparatorIndex))
        .trim()
        .toLowerCase();
      const attributeValue = attributeSeparatorIndex === -1
        ? ''
        : attribute.slice(attributeSeparatorIndex + 1).trim();

      if (attributeName === 'max-age') {
        const maxAge = Number.parseInt(attributeValue, 10);
        if (Number.isFinite(maxAge)) {
          expiresAt = Date.now() + Math.max(maxAge, 0) * 1000;
        }
      } else if (attributeName === 'expires') {
        const parsed = Date.parse(attributeValue);
        if (Number.isFinite(parsed)) {
          expiresAt = parsed;
        }
      }
    }

    return { name, value, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  }
}

export class SessionCookieJar {
  private readonly cookies = new Map<string, SessionCookieEntry>();

  constructor(private readonly allowedCookieNames: Set<string>) {}

  upsertFromHeader(headerValue: string | undefined): boolean {
    if (!headerValue) {
      return false;
    }

    let updated = false;
    for (const cookie of SetCookieParser.parseHeader(headerValue)) {
      if (!this.allowedCookieNames.has(cookie.name)) {
        continue;
      }
      this.cookies.set(cookie.name, cookie);
      updated = true;
    }

    return updated;
  }

  hasUsableCookies(expirySkewMs: number): boolean {
    this.pruneExpired(expirySkewMs);
    return this.cookies.size > 0;
  }

  clear(): void {
    this.cookies.clear();
  }

  getAuthCredentials(expirySkewMs: number): AuthCredentials {
    this.pruneExpired(expirySkewMs);

    if (this.cookies.size === 0) {
      return { headers: {} };
    }

    return {
      headers: {
        Cookie: Array.from(this.cookies.values())
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join('; '),
      },
    };
  }

  private pruneExpired(expirySkewMs: number): void {
    const now = Date.now() + Math.max(expirySkewMs, 0);
    for (const [name, cookie] of this.cookies.entries()) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.cookies.delete(name);
      }
    }
  }
}

export class SessionCookieCoordinator {
  private inFlightLogin?: Promise<void>;
  private blockedUntil = 0;

  constructor(private readonly failureBackoffMs: number) {}

  async run(operation: () => Promise<void>): Promise<void> {
    const now = Date.now();
    if (this.inFlightLogin) {
      return this.inFlightLogin;
    }

    if (this.blockedUntil > now) {
      throw new SessionCookieBackoffError('Session cookie relogin temporarily suspended', {
        retryAfterMs: this.blockedUntil - now,
      });
    }

    this.inFlightLogin = (async () => {
      try {
        await operation();
        this.blockedUntil = 0;
      } catch (error) {
        this.blockedUntil = Date.now() + this.failureBackoffMs;
        throw error;
      } finally {
        this.inFlightLogin = undefined;
      }
    })();

    return this.inFlightLogin;
  }
}

export class SessionCookieAuthManager implements AuthRuntimeProvider {
  private readonly baseUrl = new URL(this.baseUrlValue);
  private readonly cookieJar = new SessionCookieJar(new Set(this.config.cookie_names));
  private readonly reauthOnStatuses = new Set(this.config.reauth_on_statuses || [401]);
  private readonly coordinator: SessionCookieCoordinator;
  private readonly ssrfValidator: SSRFValidator;

  constructor(
    private readonly config: SessionCookieConfig,
    private readonly baseUrlValue: string,
    private readonly logger?: Logger,
    private readonly requestTimeoutMs: number = TIMEOUTS.HTTP_REQUEST_TIMEOUT_MS,
  ) {
    this.coordinator = new SessionCookieCoordinator(this.config.failure_backoff_ms ?? 5000);
    // Use the provided logger or create a fallback one (SSRFValidator needs one).
    // To avoid circular dependency with console logger we just mock it if missing,
    // though in practice HTTP transport always passes one.
    this.ssrfValidator = new SSRFValidator(this.logger || {
      debug: () => {}, info: () => {}, warn: () => {}, error: () => {}
    });
  }

  async prepareRequest(_ctx: RequestContext): Promise<AuthCredentials> {
    if (!this.cookieJar.hasUsableCookies(this.getExpirySkewMs())) {
      await this.ensureLoggedIn();
    }

    const credentials = this.cookieJar.getAuthCredentials(this.getExpirySkewMs());
    if (Object.keys(credentials.headers).length === 0) {
      throw new SessionCookieExpiredError('Session cookie expired before request');
    }

    return credentials;
  }

  getAuthCredentials(): AuthCredentials {
    return this.cookieJar.getAuthCredentials(this.getExpirySkewMs());
  }

  async onResponse(response: ResponseContext): Promise<void> {
    const updated = this.cookieJar.upsertFromHeader(
      getHeaderValueCaseInsensitive(response.headers, 'set-cookie')
    );

    if (updated) {
      this.logger?.debug('Session cookie updated from response');
    }
  }

  async handleAuthFailure(response: ResponseContext): Promise<boolean> {
    if (!this.reauthOnStatuses.has(response.status)) {
      return false;
    }

    this.cookieJar.clear();
    await this.ensureLoggedIn();
    return true;
  }

  private async ensureLoggedIn(): Promise<void> {
    await this.coordinator.run(async () => {
      const loginUrl = this.resolveLoginUrl();

      await this.ssrfValidator.validate(loginUrl, {
        allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true',
      });

      const request = this.buildLoginRequest();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      let response: Response;

      try {
        response = await fetch(loginUrl, {
          method: this.config.login_method || 'POST',
          headers: request.headers,
          body: request.body,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new SessionCookieLoginError('Session cookie login timed out', {
            timeoutMs: this.requestTimeoutMs,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }

      if (response.status < 200 || response.status >= 300) {
        const errorBody = await response.text();
        throw new SessionCookieLoginError(
          errorBody || `Session cookie login failed: HTTP ${response.status}`,
          { statusCode: response.status }
        );
      }

      const updated = this.cookieJar.upsertFromHeader(getSetCookieHeader(response.headers));
      if (!updated) {
        throw new SessionCookieMissingError('Expected session cookie was not returned by login');
      }
    });
  }

  private resolveLoginUrl(): string {
    const loginUrl = new URL(this.config.login_endpoint, this.baseUrl);
    const isAbsolute = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(this.config.login_endpoint);

    if (
      isAbsolute
      && loginUrl.origin !== this.baseUrl.origin
      && !isHostnameAllowed(loginUrl.hostname, this.config.login_allowed_hosts)
    ) {
      throw new ConfigurationError(
        `login_endpoint origin '${loginUrl.origin}' is not allowed (must match base_url origin or login_allowed_hosts)`
      );
    }

    return loginUrl.toString();
  }

  private buildLoginRequest(): { headers: Record<string, string>; body: string | URLSearchParams } {
    const username = this.readRequiredEnv(this.config.username_from_env);
    const password = this.readRequiredEnv(this.config.password_from_env);
    const contentType = this.config.login_content_type || 'application/json';
    const payload = {
      ...(this.config.login_static_body || {}),
      [this.config.username_field]: username,
      [this.config.password_field]: password,
    };
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      ...(this.config.login_static_headers || {}),
    };

    for (const headerName of Object.keys(headers)) {
      if (!isSafePropertyName(headerName)) {
        throw new ConfigurationError(`Invalid login header name: ${headerName}`);
      }
    }

    if (contentType === 'application/x-www-form-urlencoded') {
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(payload)) {
        body.set(key, value);
      }
      return { headers, body };
    }

    return { headers, body: JSON.stringify(payload) };
  }

  private readRequiredEnv(envVarName: string): string {
    const value = process.env[envVarName];
    if (!value) {
      throw new ConfigurationError(`Session cookie auth requires environment variable: ${envVarName}`, {
        envVarName,
      });
    }
    return value;
  }

  private getExpirySkewMs(): number {
    return Math.max(this.config.expiry_skew_ms ?? 30_000, 0);
  }
}
