import { describe, it, expect } from 'vitest';
import { ToolGenerator } from './tool-generator.js';
import { OpenAPIParser } from './openapi-parser.js';
import type { ProxyDownloadOperation } from './types/profile.js';

describe('ProxyDownloadOperation handling', () => {
  it('should return ProxyDownloadOperation object for proxy_download type', () => {
    const parser = new OpenAPIParser();
    const generator = new ToolGenerator(parser);

    const proxyDownloadOp: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/issues/{id}/attachments/{attachmentId}',
      url_field: 'url'
    };

    const toolDef = {
      name: 'download_attachment',
      description: 'Download file attachment',
      operations: {
        download: proxyDownloadOp
      }
    };

    const result = generator.getOperationDefinition(toolDef, { action: 'download' });

    // After fix: getOperationDefinition returns the ProxyDownloadOperation object
    expect(result).toEqual(proxyDownloadOp);
    expect(typeof result).toBe('object');
    if (typeof result === 'object') {
      expect(result.type).toBe('proxy_download');
      expect(result.metadata_endpoint).toBe('get_/issues/{id}/attachments/{attachmentId}');
      expect(result.url_field).toBe('url');
    }
  });

  it('should return operationId string for string operation', () => {
    const parser = new OpenAPIParser();
    const generator = new ToolGenerator(parser);

    const toolDef = {
      name: 'get_attachment',
      description: 'Get attachment metadata',
      operations: {
        get: 'get_/issues/{id}/attachments/{attachmentId}'
      }
    };

    const result = generator.getOperationDefinition(toolDef, { action: 'get' });

    expect(result).toBe('get_/issues/{id}/attachments/{attachmentId}');
    expect(typeof result).toBe('string');
  });

  it('mapActionToOperation should return undefined for proxy_download (by design)', () => {
    const parser = new OpenAPIParser();
    const generator = new ToolGenerator(parser);

    const toolDef = {
      name: 'download_attachment',
      description: 'Download file attachment',
      operations: {
        download: {
          type: 'proxy_download',
          metadata_endpoint: 'get_/issues/{id}/attachments/{attachmentId}',
          url_field: 'url'
        } as ProxyDownloadOperation
      }
    };

    const result = generator.mapActionToOperation(toolDef, { action: 'download' });

    // mapActionToOperation returns undefined for proxy_download (correct behavior)
    // because proxy_download is handled separately in executeSimpleTool
    expect(result).toBeUndefined();
  });

  it('mapActionToOperation should return operationId for string operations', () => {
    const parser = new OpenAPIParser();
    const generator = new ToolGenerator(parser);

    const toolDef = {
      name: 'get_attachment',
      description: 'Get attachment metadata',
      operations: {
        get: 'get_/issues/{id}/attachments/{attachmentId}'
      }
    };

    const result = generator.mapActionToOperation(toolDef, { action: 'get' });

    expect(result).toBe('get_/issues/{id}/attachments/{attachmentId}');
  });
});
