import { expect } from 'vitest';
import { CapturedRequest } from './dynamic-mock-server.js';
import { RequestExpectation } from './test-schema.js';

function normalizeToStrings(value: string | number | boolean | Array<string | number | boolean>): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(entry => String(entry)).sort();
}

function findMatchingRequest(
  requests: CapturedRequest[],
  expectation: RequestExpectation
): CapturedRequest | undefined {
  return requests.find(request => {
    if (expectation.method && request.method.toUpperCase() !== expectation.method.toUpperCase()) {
      return false;
    }

    if (expectation.path && request.path !== expectation.path) {
      return false;
    }

    if (expectation.origin && request.origin !== expectation.origin) {
      return false;
    }

    return true;
  });
}

function assertSingleRequestMatch(
  matchingRequest: CapturedRequest,
  expectation: RequestExpectation
): void {
  if (expectation.method) {
    expect(matchingRequest.method).toBe(expectation.method.toUpperCase());
  }

  if (expectation.path) {
    expect(matchingRequest.path).toBe(expectation.path);
  }

  if (expectation.origin) {
    expect(matchingRequest.origin).toBe(expectation.origin);
  }

  if (expectation.headers) {
    for (const [key, value] of Object.entries(expectation.headers)) {
      const actual = matchingRequest.headers[key.toLowerCase()];
      expect(actual).toBeDefined();
      expect(actual).toBe(value);
    }
  }

  if (expectation.headers_absent) {
    for (const header of expectation.headers_absent) {
      const actual = matchingRequest.headers[header.toLowerCase()];
      expect(actual).toBeUndefined();
    }
  }

  if (expectation.query) {
    for (const [key, value] of Object.entries(expectation.query)) {
      const actual = matchingRequest.query[key];
      expect(actual).toBeDefined();
      const expectedValues = normalizeToStrings(value as string | number | boolean | Array<string | number | boolean>);
      const actualValues = normalizeToStrings(actual as string | number | boolean | Array<string>);
      expect(actualValues).toEqual(expectedValues);
    }
  }

  if (expectation.body !== undefined) {
    if (typeof expectation.body === 'object' && expectation.body !== null) {
      expect(matchingRequest.body).toMatchObject(expectation.body as Record<string, unknown>);
    } else {
      expect(matchingRequest.body).toEqual(expectation.body);
    }
  }
}

function matchesExpectation(
  request: CapturedRequest,
  expectation: RequestExpectation
): boolean {
  try {
    assertSingleRequestMatch(request, expectation);
    return true;
  } catch {
    return false;
  }
}

export function assertRequestMatches(
  requests: CapturedRequest[],
  expectation: RequestExpectation
): void {
  if (requests.length === 0) {
    throw new Error('No requests were captured for this scenario.');
  }

  const matchingRequest = findMatchingRequest(requests, expectation);
  if (!matchingRequest) {
    throw new Error('Expected request was not executed for this scenario.');
  }

  assertSingleRequestMatch(matchingRequest, expectation);
}

export function assertRequestsSequence(
  requests: CapturedRequest[],
  expectations: RequestExpectation[],
  allowAdditional: boolean = false
): void {
  if (expectations.length === 0) {
    if (!allowAdditional && requests.length > 0) {
      throw new Error('Unexpected requests were captured.');
    }
    return;
  }

  if (!allowAdditional) {
    if (requests.length !== expectations.length) {
      throw new Error(`Captured ${requests.length} requests but expected ${expectations.length}.`);
    }

    expectations.forEach((expectation, index) => {
      const request = requests[index];
      if (!request) {
        throw new Error(`Missing request at index ${index}.`);
      }
      assertSingleRequestMatch(request, expectation);
    });
    return;
  }

  if (requests.length < expectations.length) {
    throw new Error('Not all expected requests were captured.');
  }

  let searchStart = 0;
  expectations.forEach((expectation, expectationIndex) => {
    const foundIndex = requests.findIndex((request, idx) => idx >= searchStart && matchesExpectation(request, expectation));
    if (foundIndex === -1) {
      throw new Error(`Missing request for expectation at index ${expectationIndex}.`);
    }
    searchStart = foundIndex + 1;
  });
}
