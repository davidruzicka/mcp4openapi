import { describe, expect, it } from 'vitest';
import {
  extractUpstreamCredentials,
  UPSTREAM_AUTH_HEADER,
} from './upstream-credential-extractor.js';

describe('UPSTREAM_AUTH_HEADER', () => {
  it('equals lowercase x-upstream-authorization', () => {
    expect(UPSTREAM_AUTH_HEADER).toBe('x-upstream-authorization');
  });
});

describe('extractUpstreamCredentials', () => {
  const allowed = ['provider-a', 'provider-b'];

  it('extracts single provider from header', () => {
    const headers = { [UPSTREAM_AUTH_HEADER]: 'provider-a=tok123' };
    const result = extractUpstreamCredentials(headers, allowed);
    expect(result).toBeInstanceOf(Map);
    expect(result?.get('provider-a')).toBe('tok123');
    expect(result?.size).toBe(1);
  });

  it('extracts multiple comma-separated providers', () => {
    const headers = { [UPSTREAM_AUTH_HEADER]: 'provider-a=tok1,provider-b=tok2' };
    const result = extractUpstreamCredentials(headers, allowed);
    expect(result?.get('provider-a')).toBe('tok1');
    expect(result?.get('provider-b')).toBe('tok2');
    expect(result?.size).toBe(2);
  });

  it('returns undefined for missing header', () => {
    const result = extractUpstreamCredentials({}, allowed);
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty header value', () => {
    const headers = { [UPSTREAM_AUTH_HEADER]: '' };
    const result = extractUpstreamCredentials(headers, allowed);
    expect(result).toBeUndefined();
  });

  it('ignores unknown providers not in allowedProviders', () => {
    const headers = { [UPSTREAM_AUTH_HEADER]: 'unknown-prov=tok1,provider-a=tok2' };
    const result = extractUpstreamCredentials(headers, allowed);
    expect(result?.has('unknown-prov')).toBe(false);
    expect(result?.get('provider-a')).toBe('tok2');
    expect(result?.size).toBe(1);
  });

  it('returns undefined when all providers are unknown', () => {
    const headers = { [UPSTREAM_AUTH_HEADER]: 'unknown-a=tok1,unknown-b=tok2' };
    const result = extractUpstreamCredentials(headers, allowed);
    expect(result).toBeUndefined();
  });

  it('handles base64 tokens with = chars by splitting on first = only', () => {
    const headers = { [UPSTREAM_AUTH_HEADER]: 'provider-a=dG9rZW4xMjM=' };
    const result = extractUpstreamCredentials(headers, allowed);
    expect(result?.get('provider-a')).toBe('dG9rZW4xMjM=');
  });

  it('trims whitespace from provider names and tokens', () => {
    const headers = { [UPSTREAM_AUTH_HEADER]: ' provider-a = tok123 , provider-b = tok456 ' };
    const result = extractUpstreamCredentials(headers, allowed);
    expect(result?.get('provider-a')).toBe('tok123');
    expect(result?.get('provider-b')).toBe('tok456');
  });

  it('handles array header values (Express can return string[])', () => {
    const headers = { [UPSTREAM_AUTH_HEADER]: ['provider-a=tok1', 'provider-b=tok2'] };
    const result = extractUpstreamCredentials(headers, allowed);
    // When array, join by comma and parse
    expect(result?.get('provider-a')).toBe('tok1');
    expect(result?.get('provider-b')).toBe('tok2');
  });
});
