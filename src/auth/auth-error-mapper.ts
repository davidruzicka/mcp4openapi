import { HTTP_STATUS } from '../core/constants.js';
import {
  EnterpriseIssuerDiscoveryError,
  EnterprisePolicyViolationError,
  EnterpriseTokenReplayError,
  EnterpriseTokenValidationError,
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
  if (error instanceof EnterpriseIssuerDiscoveryError || error instanceof ValidationError) {
    return { status: HTTP_STATUS.BAD_REQUEST, correlationId, body: { error: 'invalid_request', error_description: sanitizeAuthErrorMessage(error.message), correlationId } };
  }
  return { status: HTTP_STATUS.INTERNAL_SERVER_ERROR, correlationId, body: { error: 'server_error', error_description: 'Enterprise authorization failed', correlationId } };
}
