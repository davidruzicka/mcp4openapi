import { describe, expect, it } from 'vitest';
import { parseOAuthMetadataEndpoints } from './oauth-metadata.js';

describe('parseOAuthMetadataEndpoints', () => {
  it('returns null for non-object metadata', () => {
    expect(parseOAuthMetadataEndpoints(null)).toBeNull();
    expect(parseOAuthMetadataEndpoints('invalid')).toBeNull();
    expect(parseOAuthMetadataEndpoints(123)).toBeNull();
  });

  it('returns null when required endpoints are missing or invalid', () => {
    expect(parseOAuthMetadataEndpoints({})).toBeNull();
    expect(
      parseOAuthMetadataEndpoints({
        authorization_endpoint: '/authorize',
        token_endpoint: 123,
      })
    ).toBeNull();
  });

  it('returns parsed endpoints when metadata is valid', () => {
    expect(
      parseOAuthMetadataEndpoints({
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
      })
    ).toEqual({
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
    });
  });
});
