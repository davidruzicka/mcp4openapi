import { ConfigurationError } from '../core/errors.js';

export interface ArtifactTrustConfig {
  readonly signing?: {
    readonly key: string;
    readonly keyId: string;
  };
  readonly allowUnsigned: boolean;
}

const DEFAULT_KEY_ID = 'default';

export function readArtifactTrustConfig(env: NodeJS.ProcessEnv): ArtifactTrustConfig {
  const key = normalizeOptionalString(env.MCP4_AGENT_ARTIFACT_SIGNING_KEY);
  const keyId = normalizeOptionalString(env.MCP4_AGENT_ARTIFACT_KEY_ID) ?? DEFAULT_KEY_ID;
  const explicitAllowUnsigned = parseExplicitBoolean(
    env.MCP4_AGENT_ARTIFACT_ALLOW_UNSIGNED,
    'MCP4_AGENT_ARTIFACT_ALLOW_UNSIGNED',
  );

  return {
    allowUnsigned: explicitAllowUnsigned ?? (key ? false : true),
    ...(key
      ? {
          signing: {
            key,
            keyId,
          },
        }
      : {}),
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseExplicitBoolean(value: string | undefined, envName: string): boolean | undefined {
  const normalized = normalizeOptionalString(value);
  if (normalized === undefined) {
    return undefined;
  }
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new ConfigurationError(`${envName} must be either 'true' or 'false', got '${normalized}'.`);
}
