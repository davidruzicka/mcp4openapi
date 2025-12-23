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

    return true;
  });
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

  if (expectation.method) {
    expect(matchingRequest.method).toBe(expectation.method.toUpperCase());
  }

  if (expectation.path) {
    expect(matchingRequest.path).toBe(expectation.path);
  }

  if (expectation.headers) {
    for (const [key, value] of Object.entries(expectation.headers)) {
      const actual = matchingRequest.headers[key.toLowerCase()];
      expect(actual).toBeDefined();
      expect(actual).toBe(value);
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
