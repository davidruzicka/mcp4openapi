/**
 * Tool filter specific errors
 */

import { ConfigurationError as BaseConfigError, ValidationError as BaseValidationError } from '../core/errors.js';

/**
 * Invalid regex pattern error
 */
export class InvalidRegexError extends BaseConfigError {
  constructor(
    public readonly context: string,
    public readonly pattern: string,
    public readonly reason: string
  ) {
    super(`${context} regex '${pattern}' is invalid: ${reason}`);
    this.name = 'InvalidRegexError';
  }
}

/**
 * Re-export base errors for convenience
 */
export { BaseConfigError as ConfigurationError, BaseValidationError as ValidationError };
