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

export interface HttpClient {
  request(
    method: string,
    url: string,
    options?: {
      headers?: Record<string, string>;
      body?: unknown;
    }
  ): Promise<ResponseContext>;
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
  constructor(private httpClient: HttpClient) {}

  /**
   * Execute proxy download operation
   * 
   * @param operation Proxy download configuration
   * @param path API path with substituted parameters
   * @param authCredentials Auth credentials (headers + query params) for download
   */
  async execute(
    operation: ProxyDownloadOperation,
    path: string,
    authCredentials: AuthCredentials
  ): Promise<ProxyDownloadResult> {
    const maxSize = this.resolveMaxSize(operation);
    const timeout = operation.timeout_ms ?? DEFAULT_TIMEOUT;
    const urlField = operation.url_field ?? 'url';

    // Step 1: Fetch metadata
    const metadataResponse = await this.httpClient.request('GET', path);
    const metadata = metadataResponse.body as Record<string, unknown>;

    // Step 2: Extract URL from metadata
    const url = this.extractUrl(metadata, urlField);
    if (!url) {
      throw new ValidationError(
        `URL field '${urlField}' not found in metadata response`
      );
    }

    // Step 3: Check MIME type whitelist (from metadata if available)
    const mimeType = (metadata['mimeType'] as string) || 'application/octet-stream';
    if (operation.allowed_mime_types) {
      if (!this.isMimeTypeAllowed(mimeType, operation.allowed_mime_types)) {
        throw new ValidationError(
          `MIME type '${mimeType}' not in whitelist: ${operation.allowed_mime_types.join(', ')}`
        );
      }
    }

    // Step 4: Check file size (from metadata if available)
    const reportedSize = metadata['size'] as number | undefined;
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
        fileName: metadata['name'] as string | undefined,
      };
    }

    const skipAuth = operation.skip_auth ?? false;
    const { content, size } = await this.downloadWithAuth(
      url,
      authCredentials,
      maxSize,
      timeout,
      skipAuth
    );

    return {
      metadata,
      content,
      mimeType,
      size,
      fileName: metadata['name'] as string | undefined,
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
    skipAuth: boolean = false
  ): Promise<{ content: string; size: number }> {
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
