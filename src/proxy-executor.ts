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

export interface DebugLogger {
  debug(message: string, context?: Record<string, unknown>): void;
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
      this.enforceCrossOriginAuth(downloadUrl, baseOrigin, skipAuth);
      const { content, size, mimeType } = await this.downloadWithAuth(
        downloadUrl,
        authCredentials,
        maxSize,
        timeout,
        skipAuth,
        directDownloadRequest.method
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
    this.enforceCrossOriginAuth(downloadUrl, baseOrigin, skipAuth);
    const { content, size, mimeType: responseMime } = await this.downloadWithAuth(
      downloadUrl,
      authCredentials,
      maxSize,
      timeout,
      skipAuth
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

  private enforceCrossOriginAuth(downloadUrl: string, baseOrigin: string, skipAuth: boolean): void {
    if (skipAuth) return;

    const downloadOrigin = new URL(downloadUrl).origin;
    if (downloadOrigin !== baseOrigin) {
      throw new ValidationError(
        `Cross-origin download URL not allowed with authentication (base origin '${baseOrigin}', download origin '${downloadOrigin}'). Set skip_auth=true or use a same-origin download endpoint.`
      );
    }
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
    skipAuth: boolean = false,
    method: string = 'GET'
  ): Promise<{ content: string; size: number; mimeType?: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // Build download URL, adding query auth param if needed (and not skipping auth)
      let downloadUrl = url;
      if (!skipAuth && authCredentials.queryParams) {
        const urlObj = new URL(url);
        const { key, value } = authCredentials.queryParams;
        
        // Only add if not already present (URL may have pre-signed token)
        if (!urlObj.searchParams.has(key)) {
          urlObj.searchParams.set(key, value);
          downloadUrl = urlObj.toString();
        }
      }

      const response = await fetch(downloadUrl, {
        method,
        headers: skipAuth ? {} : authCredentials.headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new NetworkError(
          `Download failed: HTTP ${response.status}`,
          response.status
        );
      }

      // Check content-length header
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > maxSize) {
        throw new ValidationError(
          `File size ${contentLength} exceeds maximum ${maxSize} bytes`
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      
      // Final size check
      if (arrayBuffer.byteLength > maxSize) {
        throw new ValidationError(
          `Downloaded file size ${arrayBuffer.byteLength} exceeds maximum ${maxSize} bytes`
        );
      }

      // Convert to base64
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const content = btoa(binary);

      return {
        content,
        size: arrayBuffer.byteLength,
        mimeType: response.headers.get('content-type') || undefined,
      };

    } finally {
      clearTimeout(timeoutId);
    }
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
