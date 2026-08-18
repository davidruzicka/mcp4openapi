import { describe, expect, it } from 'vitest';
import { mapAuthError } from './auth-error-mapper.js';
import {
  AuthenticationError,
  EnterpriseIssuerDiscoveryError,
  EnterprisePolicyViolationError,
  EnterpriseTokenReplayError,
  EnterpriseTokenValidationError,
  OAuthInvalidGrantError,
  OAuthUpstreamError,
  ValidationError,
} from '../core/errors.js';

describe('mapAuthError', () => {
  it('maps replay and validation failures to invalid_grant', () => {
    for (const error of [
      new EnterpriseTokenReplayError('replayed assertion'),
      new EnterpriseTokenValidationError('invalid assertion'),
      new EnterprisePolicyViolationError('client is not allowed'),
    ]) {
      const response = mapAuthError(error);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_grant');
      expect(response.body.error_description).toBeTypeOf('string');
      expect(response.body.correlationId).toBe(response.correlationId);
    }
  });

  it('maps discovery and validation request failures to invalid_request', () => {
    for (const error of [
      new EnterpriseIssuerDiscoveryError('failed discovery'),
      new ValidationError('missing form field'),
    ]) {
      const response = mapAuthError(error);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
      expect(response.body.correlationId).toBe(response.correlationId);
    }
  });

  it('maps standard token grant failures to invalid_grant (RFC 6749 5.2)', () => {
    for (const error of [
      new OAuthInvalidGrantError('authorization code already used'),
      new AuthenticationError('refresh token envelope could not be verified'),
    ]) {
      const response = mapAuthError(error);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_grant');
      expect(response.body.error_description).toBeTypeOf('string');
    }
  });

  it('maps an upstream authorization-server failure to server_error 502', () => {
    const response = mapAuthError(new OAuthUpstreamError('Token exchange failed: 503'));
    expect(response.status).toBe(502);
    expect(response.body.error).toBe('server_error');
    // The upstream error text is not echoed back to the client.
    expect(response.body.error_description).toBe('Upstream authorization server error');
  });

  it('maps unexpected failures to server_error without leaking details', () => {
    const response = mapAuthError(new Error('sensitive token value'));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'server_error',
      error_description: 'Enterprise authorization failed',
      correlationId: response.correlationId,
    });
  });
});
