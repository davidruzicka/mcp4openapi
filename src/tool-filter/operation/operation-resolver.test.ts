import { describe, it, expect, vi } from 'vitest';
import { OpenAPIOperationResolver } from './operation-resolver.js';
import type { OpenAPIParser } from '../../openapi/openapi-parser.js';
import type { OperationInfo } from '../../types/openapi.js';

describe('OpenAPIOperationResolver', () => {
  describe('getOperationById', () => {
    it('resolves operation by ID', () => {
      const mockOperation: OperationInfo = {
        operationId: 'getUser',
        method: 'get',
        path: '/users/{id}',
        parameters: []
      };
      
      const parser = {
        getOperation: vi.fn().mockReturnValue(mockOperation)
      } as any as OpenAPIParser;
      
      const resolver = new OpenAPIOperationResolver(parser);
      const result = resolver.getOperationById('getUser');
      
      expect(result).toBe(mockOperation);
      expect(parser.getOperation).toHaveBeenCalledWith('getUser');
    });

    it('returns undefined for unknown operation', () => {
      const parser = {
        getOperation: vi.fn().mockReturnValue(undefined)
      } as any as OpenAPIParser;
      
      const resolver = new OpenAPIOperationResolver(parser);
      const result = resolver.getOperationById('unknown');
      
      expect(result).toBeUndefined();
    });
  });

  describe('getOperationForCall', () => {
    it('resolves operation from method and path', () => {
      const mockOperation: OperationInfo = {
        operationId: 'listUsers',
        method: 'get',
        path: '/users',
        parameters: []
      };
      
      const parser = {
        getPath: vi.fn().mockReturnValue({
          operations: {
            get: mockOperation
          }
        })
      } as any as OpenAPIParser;
      
      const resolver = new OpenAPIOperationResolver(parser);
      const result = resolver.getOperationForCall('GET /users');
      
      expect(result).toBe(mockOperation);
      expect(parser.getPath).toHaveBeenCalledWith('/users');
    });

    it('handles lowercase method', () => {
      const mockOperation: OperationInfo = {
        operationId: 'createUser',
        method: 'post',
        path: '/users',
        parameters: []
      };
      
      const parser = {
        getPath: vi.fn().mockReturnValue({
          operations: {
            post: mockOperation
          }
        })
      } as any as OpenAPIParser;
      
      const resolver = new OpenAPIOperationResolver(parser);
      const result = resolver.getOperationForCall('post /users');
      
      expect(result).toBe(mockOperation);
    });

    it('returns undefined for invalid call format', () => {
      const parser = {
        getPath: vi.fn()
      } as any as OpenAPIParser;
      
      const resolver = new OpenAPIOperationResolver(parser);
      
      expect(resolver.getOperationForCall('GET')).toBeUndefined();
      expect(resolver.getOperationForCall('')).toBeUndefined();
      expect(parser.getPath).not.toHaveBeenCalled();
    });

    it('returns undefined for unknown path', () => {
      const parser = {
        getPath: vi.fn().mockReturnValue(undefined)
      } as any as OpenAPIParser;
      
      const resolver = new OpenAPIOperationResolver(parser);
      const result = resolver.getOperationForCall('GET /unknown');
      
      expect(result).toBeUndefined();
    });

    it('returns undefined for unknown method on known path', () => {
      const parser = {
        getPath: vi.fn().mockReturnValue({
          operations: {
            get: { operationId: 'list', method: 'get', path: '/items', parameters: [] }
          }
        })
      } as any as OpenAPIParser;
      
      const resolver = new OpenAPIOperationResolver(parser);
      const result = resolver.getOperationForCall('POST /items');
      
      expect(result).toBeUndefined();
    });
  });
});
