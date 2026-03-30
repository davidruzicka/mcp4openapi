const SECRET_FIELD_NAMES = new Set([
  'assertion',
  'subject_token',
  'access_token',
  'refresh_token',
  'authorization',
  'upstream_token',
  'upstream_credentials',
  'x-api-key',
  'x_api_key',
  'api_key',
]);

function looksLikeJwt(value: string): boolean {
  return value.split('.').length === 3 && value.length > 24;
}

export function redactString(value: string): string {
  if (looksLikeJwt(value)) {
    return '[REDACTED_JWT]';
  }
  if (value.length > 16) {
    return '[REDACTED_SECRET]';
  }
  return '[REDACTED]';
}

function redactAuthPayloadInternal<T>(value: T, forceRedaction: boolean): T {
  if (typeof value === 'string') {
    return (forceRedaction ? redactString(value) : value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactAuthPayloadInternal(entry, forceRedaction)) as T;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const shouldRedact = forceRedaction || SECRET_FIELD_NAMES.has(key);
    if (shouldRedact && (typeof entry !== 'object' || entry === null)) {
      result[key] = typeof entry === 'string' ? redactString(entry) : '[REDACTED]';
      continue;
    }
    result[key] = redactAuthPayloadInternal(entry, shouldRedact);
  }
  return result as T;
}

export function redactAuthPayload<T>(value: T): T {
  return redactAuthPayloadInternal(value, false);
}

export function sanitizeAuthErrorMessage(message: string): string {
  return message
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    .replace(/(Bearer)\s+(\S{20,})/gi, (_, prefix: string, token: string) => `${prefix} [REDACTED]...${token.slice(-4)}`);
}
