import { describe, it, expect } from 'vitest';
import { getHttpProfileRoutingErrorMessage, HTTP_PROFILE_ROUTING_ERROR } from './startup-validation.js';

describe('startup validation', () => {
  it('returns error message when http routing disabled and no default profile', () => {
    const message = getHttpProfileRoutingErrorMessage({
      transport: 'http',
      profileRoutingEnabled: false,
      hasDefaultProfile: false,
    });

    expect(message).toBe(HTTP_PROFILE_ROUTING_ERROR);
  });

  it('returns null when routing is enabled without default profile', () => {
    const message = getHttpProfileRoutingErrorMessage({
      transport: 'http',
      profileRoutingEnabled: true,
      hasDefaultProfile: false,
    });

    expect(message).toBeNull();
  });

  it('returns null when default profile exists', () => {
    const message = getHttpProfileRoutingErrorMessage({
      transport: 'http',
      profileRoutingEnabled: false,
      hasDefaultProfile: true,
    });

    expect(message).toBeNull();
  });
});
