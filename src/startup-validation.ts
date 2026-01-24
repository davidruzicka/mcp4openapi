/**
 * Startup validation helpers for CLI.
 */

export const HTTP_PROFILE_ROUTING_ERROR =
  'HTTP profile routing is disabled and no default profile is configured.\n' +
  'Set MCP4_HTTP_PROFILE_ROUTING=true to enable /profile/:id/mcp routes, or provide MCP4_PROFILE_PATH (or --profile-path) to serve /mcp.';

export function getHttpProfileRoutingErrorMessage(options: {
  transport: string;
  profileRoutingEnabled: boolean;
  hasDefaultProfile: boolean;
  hasSpecPath: boolean;
}): string | null {
  if (options.transport !== 'http') {
    return null;
  }
  if (options.hasDefaultProfile) {
    return null;
  }
  if (options.hasSpecPath) {
    return null;
  }
  if (options.profileRoutingEnabled) {
    return null;
  }
  return HTTP_PROFILE_ROUTING_ERROR;
}
