import { HTTP_STATUS } from '../core/constants.js';
import {
  AuthenticationError,
  EnterpriseIssuerDiscoveryError,
  EnterprisePolicyViolationError,
  EnterpriseTokenReplayError,
  EnterpriseTokenValidationError,
  OAuthInvalidGrantError,
  OAuthUpstreamError,
  ValidationError,
  generateCorrelationId,
} from '../core/errors.js';
import { sanitizeAuthErrorMessage } from './auth-redaction.js';

export interface AuthErrorResponse {
  status: number;
  body: Record<string, unknown>;
  correlationId: string;
}

export function mapAuthError(error: unknown): AuthErrorResponse {
  const correlationId = generateCorrelationId();
  if (error instanceof EnterpriseTokenReplayError) {
    return { status: HTTP_STATUS.BAD_REQUEST, correlationId, body: { error: 'invalid_grant', error_description: sanitizeAuthErrorMessage(error.message), correlationId } };
  }
  if (error instanceof EnterpriseTokenValidationError || error instanceof EnterprisePolicyViolationError) {
    return { status: HTTP_STATUS.BAD_REQUEST, correlationId, body: { error: 'invalid_grant', error_description: sanitizeAuthErrorMessage(error.message), correlationId } };
  }
  // RFC 6749 §5.2: standard authorization-code/refresh grant failures.
  // AuthenticationError covers refresh-envelope identity failures (see
  // refresh-envelope.ts resolveRefreshGrant), which are grant errors.
  if (error instanceof OAuthInvalidGrantError || error instanceof AuthenticationError) {
    return { status: HTTP_STATUS.BAD_REQUEST, correlationId, body: { error: 'invalid_grant', error_description: sanitizeAuthErrorMessage(error.message), correlationId } };
  }
  // Upstream authorization-server failure: 502, not a client grant error.
  if (error instanceof OAuthUpstreamError) {
    return { status: HTTP_STATUS.BAD_GATEWAY, correlationId, body: { error: 'server_error', error_description: 'Upstream authorization server error', correlationId } };
  }
  if (error instanceof EnterpriseIssuerDiscoveryError || error instanceof ValidationError) {
    return { status: HTTP_STATUS.BAD_REQUEST, correlationId, body: { error: 'invalid_request', error_description: sanitizeAuthErrorMessage(error.message), correlationId } };
  }
  return { status: HTTP_STATUS.INTERNAL_SERVER_ERROR, correlationId, body: { error: 'server_error', error_description: 'Enterprise authorization failed', correlationId } };
}
