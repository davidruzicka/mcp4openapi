/**
 * Mock server utilities for parsing HTTP requests
 *
 * Why: Eliminates code duplication in mock server handlers
 * Provides consistent parameter parsing and validation
 */

/**
 * Parse URL from MSW request
 */
export function parseUrl(request: Request): URL {
  return new URL(request.url);
}

/**
 * Parse pagination parameters (page, per_page)
 */
export function parsePaginationParams(request: Request): { page: number; perPage: number } {
  const url = parseUrl(request);
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const perPage = parseInt(url.searchParams.get('per_page') || '20', 10);
  return { page, perPage };
}

/**
 * Parse search parameter
 */
export function parseSearchParam(request: Request): string | null {
  const url = parseUrl(request);
  return url.searchParams.get('search');
}

/**
 * Parse branch and ref parameters for repository operations
 */
export function parseBranchParams(request: Request): { branch?: string; ref?: string } {
  const url = parseUrl(request);
  return {
    branch: url.searchParams.get('branch') || undefined,
    ref: url.searchParams.get('ref') || undefined,
  };
}

/**
 * Parse scope array parameter (GitLab style: scope[]=value1&scope[]=value2)
 */
export function parseScopeParam(request: Request): string[] {
  const url = parseUrl(request);
  return url.searchParams.getAll('scope[]');
}

/**
 * Calculate pagination offset
 */
export function calculateOffset(page: number, perPage: number): number {
  return (page - 1) * perPage;
}

/**
 * Apply pagination to array data
 */
export function applyPagination<T>(
  data: T[],
  page: number,
  perPage: number
): T[] {
  const offset = calculateOffset(page, perPage);
  return data.slice(offset, offset + perPage);
}
