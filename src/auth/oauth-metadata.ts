export interface OAuthMetadataEndpoints {
  authorization_endpoint: string;
  token_endpoint: string;
}

export function parseOAuthMetadataEndpoints(metadata: unknown): OAuthMetadataEndpoints | null {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const candidate = metadata as {
    authorization_endpoint?: unknown;
    token_endpoint?: unknown;
  };

  if (
    typeof candidate.authorization_endpoint !== 'string' ||
    typeof candidate.token_endpoint !== 'string'
  ) {
    return null;
  }

  return {
    authorization_endpoint: candidate.authorization_endpoint,
    token_endpoint: candidate.token_endpoint,
  };
}
