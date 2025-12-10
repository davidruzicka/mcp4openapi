/**
 * Proxy download executor for fetching binary content through API
 * 
 * Why: LLM needs file content but URLs require authentication.
 * This executor fetches metadata, extracts URL, downloads content,
 * and returns base64-encoded result.
 */

import type { ProxyDownloadOperation } from './types/profile.js';
import type { ResponseContext } from './interceptors.js';
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
   * @param authHeaders Auth headers to use for download
   */
  async execute(
    operation: ProxyDownloadOperation,
    path: string,
    authHeaders: Record<string, string>
  ): Promise<ProxyDownloadResult> {
    const maxSize = operation.max_size_bytes ?? DEFAULT_MAX_SIZE;
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

    // Step 5: Download binary content
    const { content, size } = await this.downloadWithAuth(
      url,
      authHeaders,
      maxSize,
      timeout
    );

    return {
      metadata,
      content,
      mimeType,
      size,
      fileName: metadata['name'] as string | undefined,
    };
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
   */
  private async downloadWithAuth(
    url: string,
    authHeaders: Record<string, string>,
    maxSize: number,
    timeout: number
  ): Promise<{ content: string; size: number }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        headers: authHeaders,
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
}
