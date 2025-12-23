import { describe, expect, it } from 'vitest';
import { assertRequestMatches } from './request-assertions.js';
import { CapturedRequest } from './dynamic-mock-server.js';

const requests: CapturedRequest[] = [
  {
    method: 'GET',
    path: '/items',
    query: { page: '1', tag: ['a', 'b'] },
    headers: { 'x-id': 'abc' }
  },
  {
    method: 'POST',
    path: '/items/42',
    query: {},
    headers: { 'content-type': 'application/json' },
    body: { name: 'demo', description: 'item' }
  }
];

describe('assertRequestMatches', () => {
  it('matches method, path, headers, query, and body', () => {
    expect(() =>
      assertRequestMatches(requests, {
        method: 'GET',
        path: '/items',
        headers: { 'x-id': 'abc' },
        query: { page: 1, tag: ['b', 'a'] }
      })
    ).not.toThrow();

    expect(() =>
      assertRequestMatches(requests, {
        method: 'POST',
        path: '/items/42',
        body: { name: 'demo' }
      })
    ).not.toThrow();
  });

  it('fails when no request matches expectation', () => {
    expect(() =>
      assertRequestMatches(requests, {
        method: 'DELETE',
        path: '/items'
      })
    ).toThrowError(/Expected request was not executed/);
  });

  it('fails when query parameters differ', () => {
    expect(() =>
      assertRequestMatches(requests, {
        method: 'GET',
        path: '/items',
        query: { page: 2 }
      })
    ).toThrowError();
  });
});
