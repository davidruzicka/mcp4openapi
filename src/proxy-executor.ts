/**
 * Proxy download executor for fetching binary content through API
 * 
 * Why: LLM needs file content but URLs require authentication.
 * This executor fetches metadata, extracts URL, downloads content,
 * and returns base64-encoded result.
 */

import type { ProxyDownloadOperation } from './types/profile.js';
import type { ResponseContext, AuthCredentials } from './interceptors.js';
import { NetworkError, ValidationError } from './errors.js';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export interface DebugLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn?(message: string, context?: Record<string, unknown>): void;
}

export interface HttpClient {
  request(
    method: string,
    url: string,
    options?: {
      headers?: Record<string, string>;
      body?: unknown;
    }
  ): Promise<ResponseContext>;
  getBaseUrl(): string;
}

export interface ProxyDownloadResult {
  /** Original metadata from API */
  metadata: Record<string, unknown>;
  
  /** Base64-encoded file content */
  content: string;
  
  /** MIME type of the file */
  mimeType: string;
  
  /** File size in bytes */
  size: number;
  
  /** Original filename if available */
  fileName?: string;
}

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_TIMEOUT = 30000; // 30s
const MAX_REDIRECTS = 5;

export class ProxyDownloadExecutor {
  constructor(
    private httpClient: HttpClient,
    private logger: DebugLogger = { debug: () => {} }
  ) {}

  /**
   * Execute proxy download operation
   * 
   * @param operation Proxy download configuration
   * @param path API path with substituted parameters
   * @param authCredentials Auth credentials (headers + query params) for download
   */
  async execute(
    operation: ProxyDownloadOperation,
    metadataRequest: { path: string; method: string },
    authCredentials: AuthCredentials,
    directDownloadRequest?: { path: string; method: string }
  ): Promise<ProxyDownloadResult> {
    const maxSize = this.resolveMaxSize(operation);
    const timeout = operation.timeout_ms ?? DEFAULT_TIMEOUT;
    const urlField = operation.url_field ?? 'url';
    const baseOrigin = this.getBaseOrigin();

    // Step 1: Fetch metadata
    const metadataResponse = await this.httpClient.request(
      metadataRequest.method,
      metadataRequest.path
    );
    const metadata = metadataResponse.body as Record<string, unknown>;

    // File metadata helpers
    const fileName =
      this.extractNestedString(metadata, 'artifacts_file.filename') ||
      (metadata['file_name'] as string) ||
      (metadata['filename'] as string) ||
      (metadata['name'] as string);
    const reportedSize =
      this.extractNestedNumber(metadata, 'artifacts_file.size') ||
      (metadata['size'] as number | undefined);
    const metadataMime =
      (metadata['mimeType'] as string | undefined) ||
      (metadata['content_type'] as string | undefined) ||
      'application/octet-stream';

    // Step 2A: Direct download endpoint path (preferred when configured)
    if (directDownloadRequest) {
      const skipAuth = operation.skip_auth ?? false;
      const downloadUrl = this.resolveHttpUrl(directDownloadRequest.path);
      const { content, size, mimeType } = await this.downloadWithAuth(
        downloadUrl,
        authCredentials,
        maxSize,
        timeout,
        baseOrigin,
        skipAuth,
        directDownloadRequest.method,
        operation
      );

      if (reportedSize && reportedSize > maxSize) {
        throw new ValidationError(
          `File size ${reportedSize} exceeds maximum ${maxSize} bytes`
        );
      }

      const finalMimeType = mimeType || metadataMime;
      if (operation.allowed_mime_types) {
        if (!this.isMimeTypeAllowed(finalMimeType, operation.allowed_mime_types)) {
          throw new ValidationError(
            `MIME type '${finalMimeType}' not in whitelist: ${operation.allowed_mime_types.join(', ')}`
          );
        }
      }

      return {
        metadata,
        content,
        mimeType: finalMimeType,
        size,
        fileName,
      };
    }

    // Step 2: Extract URL from metadata
    const url = this.extractUrl(metadata, urlField);
    if (!url) {
      throw new ValidationError(
        `URL field '${urlField}' not found in metadata response`
      );
    }

    // Step 3: Check MIME type whitelist (from metadata if available)
    const mimeType = metadataMime;
    if (operation.allowed_mime_types) {
      if (!this.isMimeTypeAllowed(mimeType, operation.allowed_mime_types)) {
        throw new ValidationError(
          `MIME type '${mimeType}' not in whitelist: ${operation.allowed_mime_types.join(', ')}`
        );
      }
    }

    // Step 4: Check file size (from metadata if available)
    if (reportedSize && reportedSize > maxSize) {
      throw new ValidationError(
        `File size ${reportedSize} exceeds maximum ${maxSize} bytes`
      );
    }

    // Step 5: Download binary content (supports HTTP(S) and data URLs)
    if (url.startsWith('data:')) {
      const { content, size, mimeType: inferredMime } = this.downloadFromDataUrl(url, maxSize);
      return {
        metadata,
        content,
        mimeType: inferredMime || mimeType,
        size,
        fileName,
      };
    }

    const skipAuth = operation.skip_auth ?? false;
    const downloadUrl = this.resolveHttpUrl(url);
    const { content, size, mimeType: responseMime } = await this.downloadWithAuth(
      downloadUrl,
      authCredentials,
      maxSize,
      timeout,
      baseOrigin,
      skipAuth,
      'GET',
      operation
    );

    return {
      metadata,
      content,
      mimeType: responseMime || mimeType,
      size,
      fileName,
    };
  }

  private resolveMaxSize(operation: ProxyDownloadOperation): number {
    const envKeys = [operation.max_size_bytes_from_env, 'MCP4_PROXY_MAX_BYTES'].filter(
      Boolean
    ) as string[];

    for (const key of envKeys) {
      const rawValue = process.env[key];
      if (rawValue !== undefined) {
        const parsed = Number(rawValue);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new ValidationError(
            `Invalid max size from env ${key}: expected positive integer, got '${rawValue}'`
          );
        }
        return parsed;
      }
    }

    if (operation.max_size_bytes !== undefined) {
      return operation.max_size_bytes;
    }

    return DEFAULT_MAX_SIZE;
  }

  /**
   * Extract URL from metadata using dot-notation path
   */
  private extractUrl(metadata: Record<string, unknown>, urlField: string): string | null {
    const parts = urlField.split('.');
    let current: unknown = metadata;

    for (const part of parts) {
      if (current === null || typeof current !== 'object') {
        return null;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return typeof current === 'string' ? current : null;
  }

  private extractNestedString(metadata: Record<string, unknown>, path: string): string | undefined {
    const value = this.extractNestedValue(metadata, path);
    return typeof value === 'string' ? value : undefined;
  }

  private extractNestedNumber(metadata: Record<string, unknown>, path: string): number | undefined {
    const value = this.extractNestedValue(metadata, path);
    return typeof value === 'number' ? value : undefined;
  }

  private extractNestedValue(metadata: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = metadata;
    for (const part of parts) {
      if (current === null || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  private getBaseOrigin(): string {
    try {
      return new URL(this.httpClient.getBaseUrl()).origin;
    } catch {
      throw new ValidationError('Invalid API base URL - expected absolute http(s) URL');
    }
  }

  private resolveHttpUrl(input: string): string {
    // Absolute URL
    let absoluteUrl: URL | undefined;
    try {
      absoluteUrl = new URL(input);
    } catch (error) {
      this.logger.debug('resolveHttpUrl: input is not an absolute URL, resolving relative', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (absoluteUrl) {
      if (absoluteUrl.protocol === 'http:' || absoluteUrl.protocol === 'https:') {
        return absoluteUrl.toString();
      }
      throw new ValidationError(`Unsupported download URL scheme: '${absoluteUrl.protocol}'`);
    }

    const baseUrl = this.httpClient.getBaseUrl();
    let base: URL;
    try {
      base = new URL(baseUrl);
    } catch {
      throw new ValidationError('Invalid API base URL - expected absolute http(s) URL');
    }

    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new ValidationError(`Unsupported API base URL scheme: '${base.protocol}'`);
    }

    try {
      if (input.startsWith('/')) {
        // Preserve base URL path segments (e.g., https://host/api/v4 + /projects -> https://host/api/v4/projects)
        const combined = `${baseUrl.replace(/\/$/, '')}${input}`;
        return new URL(combined).toString();
      }

      // Relative (no leading slash) uses URL resolution semantics
      const baseForRelative = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
      return new URL(input, baseForRelative).toString();
    } catch {
      throw new ValidationError(`Invalid download URL: '${input}'`);
    }
  }

  private async enforceDownloadPolicy(
    downloadUrl: string,
    baseOrigin: string,
    operation: ProxyDownloadOperation,
    skipAuth: boolean
  ): Promise<void> {
    const downloadOrigin = new URL(downloadUrl).origin;

    if (!skipAuth) {
      if (downloadOrigin !== baseOrigin) {
        throw new ValidationError(
          `Cross-origin download URL not allowed with authentication (base origin '${baseOrigin}', download origin '${downloadOrigin}'). Set skip_auth=true or use a same-origin download endpoint.`
        );
      }
      return;
    }

    // With skip_auth, allow same-origin without additional restrictions
    if (downloadOrigin === baseOrigin) return;

    await this.enforceAllowedDownloadTarget(downloadUrl, operation);
  }

  /**
   * Check if MIME type matches whitelist (supports wildcards like 'image/*')
   */
  private isMimeTypeAllowed(mimeType: string, whitelist: string[]): boolean {
    return whitelist.some(pattern => {
      if (pattern.endsWith('/*')) {
        const prefix = pattern.slice(0, -1); // 'image/*' -> 'image/'
        return mimeType.startsWith(prefix);
      }
      return mimeType === pattern;
    });
  }

  /**
   * Download binary content and return base64
   * 
   * @param skipAuth If true, download URL is fetched without authentication headers/params
   *                 Metadata endpoint still requires auth, only the final download is unauthenticated
   */
  private async downloadWithAuth(
    url: string,
    authCredentials: AuthCredentials,
    maxSize: number,
    timeout: number,
    baseOrigin: string,
    skipAuth: boolean = false,
    method: string = 'GET',
    operation?: ProxyDownloadOperation
  ): Promise<{ content: string; size: number; mimeType?: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const initialUrl = this.buildDownloadUrlWithOptionalQueryAuth(url, authCredentials, skipAuth);
      let currentUrl = initialUrl;
      let currentMethod = method;
      let currentHeaders = skipAuth ? {} : authCredentials.headers;

      if (operation) {
        await this.enforceDownloadPolicy(currentUrl, baseOrigin, operation, skipAuth);
      }

      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const response = await fetch(currentUrl, {
          method: currentMethod,
          headers: currentHeaders,
          signal: controller.signal,
          redirect: 'manual',
        });

        if (this.isRedirectStatus(response.status)) {
          if (redirects === MAX_REDIRECTS) {
            throw new NetworkError(`Too many redirects (max ${MAX_REDIRECTS})`);
          }

          const location = response.headers.get('location');
          if (!location) {
            throw new NetworkError(`Redirect without Location header: HTTP ${response.status}`);
          }

          const nextUrl = this.resolveRedirectTarget(currentUrl, location);
          if (operation) {
            // Enforce the same policy on every redirect hop
            await this.enforceDownloadPolicy(nextUrl, baseOrigin, operation, skipAuth);
          }

          const isCrossOrigin = new URL(nextUrl).origin !== new URL(currentUrl).origin;
          if (isCrossOrigin) {
            currentHeaders = {};
          }

          if (
            response.status === 303 ||
            ((response.status === 301 || response.status === 302) &&
              currentMethod !== 'GET' &&
              currentMethod !== 'HEAD')
          ) {
            currentMethod = 'GET';
          }

          currentUrl = nextUrl;
          continue;
        }

        if (!response.ok) {
          throw new NetworkError(`Download failed: HTTP ${response.status}`, response.status);
        }

        // Check content-length header
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > maxSize) {
          throw new ValidationError(`File size ${contentLength} exceeds maximum ${maxSize} bytes`);
        }

        const arrayBuffer = await response.arrayBuffer();

        // Final size check
        if (arrayBuffer.byteLength > maxSize) {
          throw new ValidationError(
            `Downloaded file size ${arrayBuffer.byteLength} exceeds maximum ${maxSize} bytes`
          );
        }

        // Convert to base64
        const content = Buffer.from(arrayBuffer).toString('base64');

        return {
          content,
          size: arrayBuffer.byteLength,
          mimeType: response.headers.get('content-type') || undefined,
        };
      }

      throw new NetworkError('Download failed: unexpected redirect handling state');

    } finally {
      clearTimeout(timeoutId);
    }
  }

  private buildDownloadUrlWithOptionalQueryAuth(
    url: string,
    authCredentials: AuthCredentials,
    skipAuth: boolean
  ): string {
    if (skipAuth || !authCredentials.queryParams) return url;

    const urlObj = new URL(url);
    const { key, value } = authCredentials.queryParams;

    // Only add if not already present (URL may have pre-signed token)
    if (!urlObj.searchParams.has(key)) {
      urlObj.searchParams.set(key, value);
    }
    return urlObj.toString();
  }

  private isRedirectStatus(status: number): boolean {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
  }

  private resolveRedirectTarget(currentUrl: string, location: string): string {
    let resolved: URL;
    try {
      resolved = new URL(location, currentUrl);
    } catch {
      throw new NetworkError(`Invalid redirect URL: '${location}'`);
    }

    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      throw new ValidationError(`Unsupported redirect URL scheme: '${resolved.protocol}'`);
    }

    return resolved.toString();
  }

  private async enforceAllowedDownloadTarget(targetUrl: string, operation: ProxyDownloadOperation): Promise<void> {
    const url = new URL(targetUrl);
    const hostname = url.hostname.toLowerCase();
    const allowPrivateNetwork = operation.allow_private_network ?? false;

    if (operation.allowed_hosts && operation.allowed_hosts.length > 0) {
      if (!this.isAllowedHost(hostname, operation.allowed_hosts)) {
        this.logger.warn?.('proxy_download blocked: host not in allowlist', {
          hostname,
          allowed_hosts: operation.allowed_hosts,
          how_to_fix: "Add hostname to allowed_hosts, or use same-origin download endpoint.",
        });
        throw new ValidationError(
          `Download host not in allowlist: '${hostname}' (allowed_hosts: ${operation.allowed_hosts.join(', ')})`
        );
      }
    }

    if (allowPrivateNetwork) return;

    if (hostname === 'localhost') {
      this.logger.warn?.('proxy_download blocked: localhost target', {
        hostname,
        how_to_fix: "If you really need localhost, set allow_private_network=true (and consider allowed_hosts).",
      });
      throw new ValidationError('Download hostname not allowed');
    }

    const ipVersion = isIP(hostname);
    if (ipVersion === 4) {
      if (this.isDisallowedIPv4(hostname)) {
        this.logger.warn?.('proxy_download blocked: private/loopback/link-local IPv4 target', {
          hostname,
          how_to_fix: "If you really need private IPs, set allow_private_network=true (and consider allowed_hosts).",
        });
        throw new ValidationError('Download IP not allowed');
      }
    } else if (ipVersion === 6) {
      if (this.isDisallowedIPv6(hostname)) {
        this.logger.warn?.('proxy_download blocked: private/loopback/link-local IPv6 target', {
          hostname,
          how_to_fix: "If you really need private IPs, set allow_private_network=true (and consider allowed_hosts).",
        });
        throw new ValidationError('Download IP not allowed');
      }
    } else {
      // Hostname: resolve to all IPs and block if any are private/loopback/link-local (SSRF defense)
      const addresses = await this.lookupAllIpAddresses(hostname);
      const disallowed = addresses.find(address => {
        const family = isIP(address);
        if (family === 4) return this.isDisallowedIPv4(address);
        if (family === 6) return this.isDisallowedIPv6(address);
        return false;
      });

      if (disallowed) {
        this.logger.warn?.('proxy_download blocked: hostname resolves to private/loopback/link-local IP', {
          hostname,
          resolved_addresses: addresses,
          how_to_fix:
            "If this hostname must be allowed, set allow_private_network=true and restrict with allowed_hosts.",
        });
        throw new ValidationError('Download hostname resolves to disallowed IP');
      }
    }
  }

  private async lookupAllIpAddresses(hostname: string): Promise<string[]> {
    const timeoutMs = 1000;

    let results: Array<{ address: string }> = [];
    try {
      results = (await Promise.race([
        lookup(hostname, { all: true, verbatim: true }) as Promise<Array<{ address: string }>>,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`DNS lookup timeout after ${timeoutMs}ms`)), timeoutMs)
        ),
      ])) as Array<{ address: string }>;
    } catch (error) {
      this.logger.warn?.('proxy_download blocked: DNS lookup failed', {
        hostname,
        error: error instanceof Error ? error.message : String(error),
        how_to_fix:
          "If you need to allow internal hostnames, set allow_private_network=true and restrict with allowed_hosts.",
      });
      throw new ValidationError(`DNS lookup failed for hostname '${hostname}'`);
    }

    const addresses = results.map(r => r.address).filter(Boolean);
    if (addresses.length === 0) {
      this.logger.warn?.('proxy_download blocked: DNS lookup returned no addresses', {
        hostname,
        how_to_fix:
          "If you need to allow internal hostnames, set allow_private_network=true and restrict with allowed_hosts.",
      });
      throw new ValidationError(`DNS lookup returned no addresses for hostname '${hostname}'`);
    }

    return addresses;
  }

  private isAllowedHost(hostname: string, allowedHosts: string[]): boolean {
    const lower = hostname.toLowerCase();
    return allowedHosts.some(patternRaw => {
      const pattern = patternRaw.toLowerCase().trim();
      if (!pattern) return false;

      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(2);
        if (!suffix) return false;
        return lower.endsWith(`.${suffix}`);
      }

      return lower === pattern;
    });
  }

  private isDisallowedIPv4(ip: string): boolean {
    const parts = ip.split('.').map(p => Number(p));
    if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true; // "this network"
    return false;
  }

  private isDisallowedIPv6(ip: string): boolean {
    const normalized = ip.toLowerCase();
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true; // loopback
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true; // unspecified
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
      return true; // link-local fe80::/10 (approx by prefix)
    }
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local fc00::/7 (approx by prefix)
    return false;
  }

  /**
   * Handle inline data URLs (data:mime;base64,...)
   */
  private downloadFromDataUrl(url: string, maxSize: number): { content: string; size: number; mimeType: string } {
    const match = url.match(/^data:(.*?);base64,(.*)$/);
    if (!match) {
      throw new ValidationError(`Unsupported data URL format`);
    }
    const mimeType = match[1] || 'application/octet-stream';
    const base64Data = match[2];
    const size = Buffer.from(base64Data, 'base64').length;
    if (size > maxSize) {
      throw new ValidationError(`Downloaded file size ${size} exceeds maximum ${maxSize} bytes`);
    }
    return { content: base64Data, size, mimeType };
  }
}
