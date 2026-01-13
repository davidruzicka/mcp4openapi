import { describe, it, expect } from 'vitest';
import { OperationClassifier } from './operation-classifier.js';
import type { OperationInfo } from '../../types/openapi.js';

describe('OperationClassifier', () => {
  const classifier = new OperationClassifier();

  describe('GET operation classification', () => {
    it('classifies GET without path params as list', () => {
      const operation: OperationInfo = {
        operationId: 'listUsers',
        method: 'get',
        path: '/users',
        parameters: []
      };
      expect(classifier.classify(operation)).toBe('list');
    });

    it('classifies GET with path params as read', () => {
      const operation: OperationInfo = {
        operationId: 'getUser',
        method: 'get',
        path: '/users/{id}',
        parameters: [{ in: 'path', name: 'id', required: true }]
      };
      expect(classifier.classify(operation)).toBe('read');
    });

    it('classifies GET with query params but no path params as list', () => {
      const operation: OperationInfo = {
        operationId: 'searchUsers',
        method: 'get',
        path: '/users',
        parameters: [{ in: 'query', name: 'search', required: false }]
      };
      expect(classifier.classify(operation)).toBe('list');
    });

    it('classifies GET with both path and query params as read', () => {
      const operation: OperationInfo = {
        operationId: 'getUser',
        method: 'get',
        path: '/users/{id}',
        parameters: [
          { in: 'path', name: 'id', required: true },
          { in: 'query', name: 'fields', required: false }
        ]
      };
      expect(classifier.classify(operation)).toBe('read');
    });
  });

  describe('non-GET operation classification', () => {
    it('classifies POST as modify', () => {
      const operation: OperationInfo = {
        operationId: 'createUser',
        method: 'post',
        path: '/users',
        parameters: []
      };
      expect(classifier.classify(operation)).toBe('modify');
    });

    it('classifies PUT as modify', () => {
      const operation: OperationInfo = {
        operationId: 'updateUser',
        method: 'put',
        path: '/users/{id}',
        parameters: [{ in: 'path', name: 'id', required: true }]
      };
      expect(classifier.classify(operation)).toBe('modify');
    });

    it('classifies DELETE as modify', () => {
      const operation: OperationInfo = {
        operationId: 'deleteUser',
        method: 'delete',
        path: '/users/{id}',
        parameters: [{ in: 'path', name: 'id', required: true }]
      };
      expect(classifier.classify(operation)).toBe('modify');
    });

    it('classifies PATCH as modify', () => {
      const operation: OperationInfo = {
        operationId: 'patchUser',
        method: 'patch',
        path: '/users/{id}',
        parameters: [{ in: 'path', name: 'id', required: true }]
      };
      expect(classifier.classify(operation)).toBe('modify');
    });
  });

  describe('case sensitivity', () => {
    it('handles uppercase GET', () => {
      const operation: OperationInfo = {
        operationId: 'list',
        method: 'GET' as any,
        path: '/items',
        parameters: []
      };
      expect(classifier.classify(operation)).toBe('list');
    });

    it('handles mixed case POST', () => {
      const operation: OperationInfo = {
        operationId: 'create',
        method: 'Post' as any,
        path: '/items',
        parameters: []
      };
      expect(classifier.classify(operation)).toBe('modify');
    });
  });
});
