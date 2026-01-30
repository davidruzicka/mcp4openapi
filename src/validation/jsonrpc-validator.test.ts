import { describe, it, expect } from 'vitest';
import {
  isInitializeRequest,
  isToolCallRequest,
  isToolsListRequest,
  isJsonRpcRequest,
  isJsonRpcResponse
} from './jsonrpc-validator.js';

describe('JSON-RPC Validator', () => {
  describe('isInitializeRequest', () => {
    it('should return true for valid initialize request', () => {
      const message = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {}
      };
      expect(isInitializeRequest(message)).toBe(true);
    });

    it('should return false for non-initialize methods', () => {
      const message = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {}
      };
      expect(isInitializeRequest(message)).toBe(false);
    });

    it('should return false for non-objects', () => {
      expect(isInitializeRequest(null)).toBe(false);
      expect(isInitializeRequest('string')).toBe(false);
      expect(isInitializeRequest(123)).toBe(false);
    });
  });

  describe('isToolCallRequest', () => {
    it('should return true for valid tool call request', () => {
      const message = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {}
      };
      expect(isToolCallRequest(message)).toBe(true);
    });

    it('should return false for other methods', () => {
      const message = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {}
      };
      expect(isToolCallRequest(message)).toBe(false);
    });

    it('should return false for non-objects', () => {
      expect(isToolCallRequest(undefined)).toBe(false);
      expect(isToolCallRequest([])).toBe(false);
    });
  });

  describe('isToolsListRequest', () => {
    it('should return true for valid tools/list request', () => {
      const message = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      };
      expect(isToolsListRequest(message)).toBe(true);
    });

    it('should return false for other methods', () => {
      const message = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {}
      };
      expect(isToolsListRequest(message)).toBe(false);
    });
  });

  describe('isJsonRpcRequest', () => {
    it('should return true for valid JSON-RPC request', () => {
      const message = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {}
      };
      expect(isJsonRpcRequest(message)).toBe(true);
    });

    it('should return false for missing jsonrpc version', () => {
      const message = {
        id: 1,
        method: 'tools/call',
        params: {}
      };
      expect(isJsonRpcRequest(message)).toBe(false);
    });

    it('should return false for wrong jsonrpc version', () => {
      const message = {
        jsonrpc: '1.0',
        id: 1,
        method: 'tools/call',
        params: {}
      };
      expect(isJsonRpcRequest(message)).toBe(false);
    });

    it('should return false for missing id', () => {
      const message = {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {}
      };
      expect(isJsonRpcRequest(message)).toBe(false);
    });

    it('should return false for missing method', () => {
      const message = {
        jsonrpc: '2.0',
        id: 1,
        params: {}
      };
      expect(isJsonRpcRequest(message)).toBe(false);
    });
  });

  describe('isJsonRpcResponse', () => {
    it('should return true for valid JSON-RPC response with result', () => {
      const message = {
        jsonrpc: '2.0',
        id: 1,
        result: {}
      };
      expect(isJsonRpcResponse(message)).toBe(true);
    });

    it('should return true for valid JSON-RPC response with error', () => {
      const message = {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Method not found' }
      };
      expect(isJsonRpcResponse(message)).toBe(true);
    });

    it('should return false for missing jsonrpc version', () => {
      const message = {
        id: 1,
        result: {}
      };
      expect(isJsonRpcResponse(message)).toBe(false);
    });

    it('should return false for missing id', () => {
      const message = {
        jsonrpc: '2.0',
        result: {}
      };
      expect(isJsonRpcResponse(message)).toBe(false);
    });

    it('should return false for missing result or error', () => {
      const message = {
        jsonrpc: '2.0',
        id: 1
      };
      expect(isJsonRpcResponse(message)).toBe(false);
    });
  });
});

