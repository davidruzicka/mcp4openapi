const SECRET_FIELD_NAMES = new Set([
  'assertion',
  'subject_token',
  'access_token',
  'refresh_token',
  'authorization',
]);

function looksLikeJwt(value: string): boolean {
  return value.split('.').length === 3 && value.length > 24;
}

function redactString(value: string): string {
  if (looksLikeJwt(value)) {
    return '[REDACTED_JWT]';
  }
  if (value.length > 16) {
    return '[REDACTED_SECRET]';
  }
  return '[REDACTED]';
}

export function redactAuthPayload<T>(value: T): T {
  if (typeof value === 'string') {
    return redactString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactAuthPayload(entry)) as T;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_NAMES.has(key)) {
      result[key] = typeof entry === 'string' ? redactString(entry) : '[REDACTED]';
      continue;
    }
    result[key] = redactAuthPayload(entry);
  }
  return result as T;
}

export function sanitizeAuthErrorMessage(message: string): string {
  return message.replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');
}
