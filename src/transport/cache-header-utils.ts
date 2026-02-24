export type CacheControlDirectives = Map<string, string | true>;

export interface VaryHeader {
  star: boolean;
  headers: Set<string>;
}

export function getHeaderValueCaseInsensitive(
  headers: Record<string, string>,
  headerName: string
): string | undefined {
  const target = headerName.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

export function parseCacheControl(headerValue: string | undefined): CacheControlDirectives {
  const directives: CacheControlDirectives = new Map();
  if (!headerValue) {
    return directives;
  }

  for (const token of headerValue.split(',')) {
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) {
      directives.set(trimmed.toLowerCase(), true);
      continue;
    }

    const name = trimmed.slice(0, equalsIndex).trim().toLowerCase();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    const value = stripOptionalQuotes(rawValue);
    directives.set(name, value);
  }

  return directives;
}

export function hasDirective(
  directives: CacheControlDirectives,
  directiveName: string
): boolean {
  return directives.has(directiveName.toLowerCase());
}

export function getDirectiveValue(
  directives: CacheControlDirectives,
  directiveName: string
): string | true | undefined {
  return directives.get(directiveName.toLowerCase());
}

export function parseNonNegativeInteger(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

export function parseVaryHeader(headerValue: string | undefined): VaryHeader {
  if (!headerValue) {
    return { star: false, headers: new Set() };
  }

  const headers = new Set<string>();
  for (const token of headerValue.split(',')) {
    const fieldName = token.trim().toLowerCase();
    if (!fieldName) {
      continue;
    }
    if (fieldName === '*') {
      return { star: true, headers: new Set() };
    }
    headers.add(fieldName);
  }

  return { star: false, headers };
}

function stripOptionalQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}
