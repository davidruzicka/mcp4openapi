import type { ToolDefinition } from './types/profile.js';
import type { OperationInfo } from './types/openapi.js';
import { AuthorizationError, ValidationError } from './errors.js';

const CONTROL_KEYS = new Set(['_allow_list', '_allow_read']);
const KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

export type FilteringRules = Record<string, string[]>;

export interface FilteringParseResult {
  filtering: FilteringRules;
  normalizedHeader: string;
}

export function normalizeFilteringHeaderValue(value?: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function parseFilteringHeader(headerValue: string): FilteringParseResult {
  const normalizedHeader = normalizeFilteringHeaderValue(headerValue);
  if (!normalizedHeader) {
    return { filtering: Object.create(null), normalizedHeader: '' };
  }

  const maxValues = getFilterMaxValues();
  const filtering: FilteringRules = Object.create(null);

  const parts = normalizedHeader.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) {
      if (!CONTROL_KEYS.has(trimmed) || !KEY_PATTERN.test(trimmed)) {
        throw new ValidationError('Invalid X-Mcp4-Filtering header. Expected comma-separated key=value pairs.');
      }
      filtering[trimmed] = filtering[trimmed] ?? [];
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();

    if (!key || !KEY_PATTERN.test(key)) {
      throw new ValidationError('Invalid X-Mcp4-Filtering header. Expected comma-separated key=value pairs.');
    }

    if (CONTROL_KEYS.has(key)) {
      throw new ValidationError('Invalid X-Mcp4-Filtering header. Expected comma-separated key=value pairs.');
    }

    if (!rawValue) {
      continue;
    }

    let decodedValue: string;
    try {
      decodedValue = decodeURIComponent(rawValue);
    } catch {
      throw new ValidationError('Invalid X-Mcp4-Filtering header. Expected comma-separated key=value pairs.');
    }

    const values = filtering[key] ?? [];
    if (values.length >= maxValues) {
      throw new ValidationError(
        `X-Mcp4-Filtering exceeds max values for key '${key}'. Max allowed is ${maxValues}.`
      );
    }

    values.push(decodedValue);
    filtering[key] = values;
  }

  return { filtering, normalizedHeader };
}

export function isControlKey(key: string): boolean {
  return CONTROL_KEYS.has(key);
}

export function getFilterMaxValues(): number {
  const raw = process.env.MCP4_FILTER_MAX_VALUES;
  if (raw === undefined) {
    return 10;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new ValidationError(
      `Invalid MCP4_FILTER_MAX_VALUES: expected positive integer, got '${raw}'.`
    );
  }
  return parsed;
}

export function enforceFiltering(context: {
  filtering: FilteringRules;
  toolDef: ToolDefinition;
  args: Record<string, unknown>;
  parameterAliases?: Record<string, string[]>;
  operation?: OperationInfo;
}): void {
  const { filtering, toolDef, args, parameterAliases, operation } = context;
  const filterKeys = Object.keys(filtering).filter(key => !isControlKey(key));
  if (filterKeys.length === 0) {
    return;
  }

  const aliasToCanonical = buildAliasToCanonical(parameterAliases ?? {});
  const toolParamGroups = buildToolParamGroups(toolDef, parameterAliases ?? {}, aliasToCanonical);

  const allowedByCanonical = new Map<string, string[]>();
  for (const key of filterKeys) {
    const canonical = aliasToCanonical.get(key) ?? key;
    if (!toolParamGroups.has(canonical)) {
      continue;
    }
    const values = filtering[key] ?? [];
    if (values.length === 0) {
      continue;
    }
    const existing = allowedByCanonical.get(canonical) ?? [];
    existing.push(...values);
    allowedByCanonical.set(canonical, dedupe(existing));
  }

  const applicableCanonicals = Array.from(allowedByCanonical.keys());
  if (applicableCanonicals.length === 0) {
    return;
  }

  const allowList = Object.prototype.hasOwnProperty.call(filtering, '_allow_list');
  const allowRead = Object.prototype.hasOwnProperty.call(filtering, '_allow_read');

  const operationCategory = resolveOperationCategory(operation, args['action']);
  const isList = operationCategory === 'list';
  const isRead = operationCategory === 'read';
  const isModify = operationCategory === 'modify';

  const hasAnyFilterParam = applicableCanonicals.some(canonical => {
    const group = toolParamGroups.get(canonical);
    if (!group) return false;
    return getArgumentValue(args, group.names) !== undefined;
  });

  if (isModify && !hasAnyFilterParam) {
    throw new AuthorizationError(
      `Filter requires at least one of [${applicableCanonicals.join(', ')}] for tool '${toolDef.name}'.`
    );
  }

  for (const canonical of applicableCanonicals) {
    const allowedValues = allowedByCanonical.get(canonical) ?? [];
    const group = toolParamGroups.get(canonical) as { names: string[] };
    const argValue = getArgumentValue(args, group.names);

    if (argValue === undefined) {
      if ((isList && allowList) || (isRead && allowRead)) {
        continue;
      }
      if (isList || isRead) {
        throw new AuthorizationError(
          `Filter requires parameter '${canonical}' for tool '${toolDef.name}'.`
        );
      }
      continue;
    }

    const allowedSet = new Set(allowedValues);

    if (Array.isArray(argValue)) {
      for (const item of argValue) {
        if (!isPrimitiveValue(item)) {
          throw new AuthorizationError(
            `Filter conflict for '${canonical}': expected one of [${allowedValues.join(', ')}], got '${formatValue(item)}'.`
          );
        }
        const stringValue = String(item);
        if (!allowedSet.has(stringValue)) {
          throw new AuthorizationError(
            `Filter conflict for '${canonical}': expected one of [${allowedValues.join(', ')}], got '${stringValue}'.`
          );
        }
      }
      continue;
    }

    if (typeof argValue === 'object' && argValue !== null) {
      throw new AuthorizationError(
        `Filter conflict for '${canonical}': expected one of [${allowedValues.join(', ')}], got '${formatValue(argValue)}'.`
      );
    }

    const stringValue = String(argValue);
    if (!allowedSet.has(stringValue)) {
      throw new AuthorizationError(
        `Filter conflict for '${canonical}': expected one of [${allowedValues.join(', ')}], got '${stringValue}'.`
      );
    }
  }
}

function buildAliasToCanonical(parameterAliases: Record<string, string[]>): Map<string, string> {
  const aliasToCanonical = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(parameterAliases)) {
    for (const alias of aliases) {
      if (!aliasToCanonical.has(alias)) {
        aliasToCanonical.set(alias, canonical);
      }
    }
  }
  return aliasToCanonical;
}

function buildToolParamGroups(
  toolDef: ToolDefinition,
  parameterAliases: Record<string, string[]>,
  aliasToCanonical: Map<string, string>
): Map<string, { names: string[] }> {
  const groups = new Map<string, { names: string[] }>();

  for (const paramName of Object.keys(toolDef.parameters)) {
    const canonical = aliasToCanonical.get(paramName) ?? paramName;
    const aliasNames = parameterAliases[canonical] ?? [];
    const group = groups.get(canonical) ?? { names: [] };
    group.names = dedupe([canonical, ...aliasNames, paramName, ...group.names]);
    groups.set(canonical, group);
  }

  return groups;
}

function getArgumentValue(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined) {
      return args[name];
    }
  }
  return undefined;
}

function resolveOperationCategory(
  operation: OperationInfo | undefined,
  action: unknown
): 'list' | 'read' | 'modify' {
  if (operation) {
    const method = operation.method.toLowerCase();
    if (method === 'get') {
      const hasPathParams = operation.parameters.some(param => param.in === 'path');
      return hasPathParams ? 'read' : 'list';
    }
  }

  const actionValue = typeof action === 'string' ? action.toLowerCase() : '';
  if (actionValue === 'list' || actionValue === 'search') {
    return 'list';
  }
  if (actionValue === 'get' || actionValue === 'read') {
    return 'read';
  }
  return 'modify';
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isPrimitiveValue(value: unknown): value is string | number | boolean {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

function formatValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  return String(value);
}
