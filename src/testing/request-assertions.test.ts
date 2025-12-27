import { describe, expect, it } from 'vitest';
import { assertRequestMatches, assertRequestsSequence } from './request-assertions.js';
import { CapturedRequest } from './dynamic-mock-server.js';

const requests: CapturedRequest[] = [
  {
    method: 'GET',
    path: '/items',
    origin: 'https://mock.local',
    query: { page: '1', tag: ['a', 'b'] },
    headers: { 'x-id': 'abc' }
  },
  {
    method: 'POST',
    path: '/items/42',
    origin: 'https://mock.local',
    query: {},
    headers: { 'content-type': 'application/json' },
    body: { name: 'demo', description: 'item' }
  }
];

const requestsWithExtra: CapturedRequest[] = [
  {
    method: 'HEAD',
    path: '/health',
    origin: 'https://mock.local',
    query: {},
    headers: {}
  },
  ...requests,
  {
    method: 'GET',
    path: '/metrics',
    origin: 'https://mock.local',
    query: {},
    headers: {}
  }
];

describe('assertRequestMatches', () => {
  it('matches method, path, headers, query, and body', () => {
    expect(() =>
      assertRequestMatches(requests, {
        method: 'GET',
        path: '/items',
        headers: { 'x-id': 'abc' },
        query: { page: 1, tag: ['b', 'a'] },
        origin: 'https://mock.local'
      })
    ).not.toThrow();

    expect(() =>
      assertRequestMatches(requests, {
        method: 'POST',
        path: '/items/42',
        origin: 'https://mock.local',
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

  it('supports regex assertions', () => {
    expect(() =>
      assertRequestMatches(requests, {
        method: 'POST', // Ensure we pick the POST request which has a body
        path_regex: '/item.*',
        origin_regex: 'https://.*\\.local',
        headers_regex: { 'content-type': 'application/json' },
        body_regex: '.*demo.*'
      })
    ).not.toThrow();

    expect(() =>
      assertRequestMatches(requests, {
        path_regex: '/nonexistent.*'
      })
    ).toThrowError(/Expected request was not executed/);
  });

  it('checks headers_absent and sequences', () => {
    expect(() =>
      assertRequestsSequence(
        requests,
        [
          { method: 'GET', path: '/items', headers_absent: ['authorization'] },
          { method: 'POST', path: '/items/42', headers_absent: ['x-id'] }
        ],
        false
      )
    ).not.toThrow();

    expect(() =>
      assertRequestsSequence(requests, [{ method: 'GET' }], true)
    ).not.toThrow();

    expect(() =>
      assertRequestsSequence(requests, [{ method: 'GET' }], false)
    ).toThrowError();
  });

  it('supports subsequence matching when additional requests are allowed', () => {
    expect(() =>
      assertRequestsSequence(
        requestsWithExtra,
        [
          { method: 'GET', path: '/items', origin: 'https://mock.local' },
          { method: 'POST', path: '/items/42', origin: 'https://mock.local', body: { name: 'demo' } }
        ],
        true
      )
    ).not.toThrow();

    expect(() =>
      assertRequestsSequence(
        requestsWithExtra,
        [
          { method: 'POST', path: '/items/42' },
          { method: 'GET', path: '/items' }
        ],
        true
      )
    ).toThrowError(/Missing request/);
  });
});
