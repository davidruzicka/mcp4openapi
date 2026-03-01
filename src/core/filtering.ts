import type { ToolDefinition } from '../types/profile.js';
import type { OperationInfo } from '../types/openapi.js';
import { AuthorizationError, ValidationError } from './errors.js';
import type { ParameterDefinition } from '../types/profile.js';

const CONTROL_KEYS = new Set(['_allow_list', '_allow_read']);
const KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

export type FilteringRules = Record<string, string[]>;

export interface FilteringParseResult {
  filtering: FilteringRules;
  normalizedHeader: string;
}

function createFilteringRules(): FilteringRules {
  return Object.create(null) as FilteringRules;
}

function cloneFilteringRules(filtering: FilteringRules): FilteringRules {
  const cloned = createFilteringRules();
  for (const [key, values] of Object.entries(filtering)) {
    cloned[key] = Array.isArray(values) ? [...values] : [];
  }
  return cloned;
}

export function hasFilteringRules(filtering?: FilteringRules): boolean {
  return !!filtering && Object.keys(filtering).length > 0;
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
    return { filtering: createFilteringRules(), normalizedHeader: '' };
  }

  const maxValues = getFilterMaxValues();
  const filtering = createFilteringRules();

  const parts = normalizedHeader.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) {
      if (!CONTROL_KEYS.has(trimmed) || !KEY_PATTERN.test(trimmed)) {
        throw new ValidationError('Invalid X-Mcp4-Params header. Expected comma-separated key=value pairs.');
      }
      filtering[trimmed] = filtering[trimmed] ?? [];
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();

    if (!key || !KEY_PATTERN.test(key)) {
      throw new ValidationError('Invalid X-Mcp4-Params header. Expected comma-separated key=value pairs.');
    }

    if (CONTROL_KEYS.has(key)) {
      throw new ValidationError('Invalid X-Mcp4-Params header. Expected comma-separated key=value pairs.');
    }

    if (!rawValue) {
      continue;
    }

    let decodedValue: string;
    try {
      decodedValue = decodeURIComponent(rawValue);
    } catch {
      throw new ValidationError('Invalid X-Mcp4-Params header. Expected comma-separated key=value pairs.');
    }

    const values = filtering[key] ?? [];
    if (values.length >= maxValues) {
      throw new ValidationError(
        `X-Mcp4-Params exceeds max values for key '${key}'. Max allowed is ${maxValues}.`
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

export function isFilteringKeySupported(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function parseConfiguredFilteringValue(value?: string): FilteringParseResult {
  const normalizedValue = normalizeFilteringHeaderValue(value);
  if (!normalizedValue) {
    return { filtering: createFilteringRules(), normalizedHeader: '' };
  }
  return parseFilteringHeader(normalizedValue);
}

export function mergeFilteringRules(
  baseFiltering?: FilteringRules,
  additionalFiltering?: FilteringRules
): FilteringRules | undefined {
  const hasBaseFiltering = hasFilteringRules(baseFiltering);
  const hasAdditionalFiltering = hasFilteringRules(additionalFiltering);

  if (!hasBaseFiltering && !hasAdditionalFiltering) {
    return undefined;
  }
  if (!hasBaseFiltering && additionalFiltering) {
    return cloneFilteringRules(additionalFiltering);
  }
  if (!hasAdditionalFiltering && baseFiltering) {
    return cloneFilteringRules(baseFiltering);
  }

  const merged = createFilteringRules();
  const base = baseFiltering!;
  const additional = additionalFiltering!;
  const valueKeys = new Set([
    ...Object.keys(base).filter(key => !isControlKey(key)),
    ...Object.keys(additional).filter(key => !isControlKey(key)),
  ]);

  for (const key of valueKeys) {
    const baseValues = base[key] ?? [];
    const additionalValues = additional[key] ?? [];

    if (baseValues.length > 0 && additionalValues.length > 0) {
      const additionalAllowed = new Set(additionalValues);
      const intersection = dedupe(baseValues).filter(value => additionalAllowed.has(value));
      if (intersection.length === 0) {
        throw new ValidationError(
          `Filtering rules conflict for key '${key}'. No allowed values remain after applying both filters.`
        );
      }
      merged[key] = intersection;
      continue;
    }

    const fallbackValues = baseValues.length > 0 ? baseValues : additionalValues;
    if (fallbackValues.length > 0) {
      merged[key] = dedupe(fallbackValues);
    }
  }

  for (const controlKey of CONTROL_KEYS) {
    if (
      Object.prototype.hasOwnProperty.call(base, controlKey)
      && Object.prototype.hasOwnProperty.call(additional, controlKey)
    ) {
      merged[controlKey] = [];
    }
  }

  return hasFilteringRules(merged) ? merged : undefined;
}

interface FilteringContext {
  aliasToCanonical: Map<string, string>;
  toolParamGroups: Map<string, { names: string[] }>;
  allowedByCanonical: Map<string, string[]>;
  applicableCanonicals: string[];
  operationCategory: 'list' | 'read' | 'modify';
  hasAnyFilterParam: boolean;
  permissions: { allowList: boolean; allowRead: boolean };
  action?: string;
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

function prepareFilteringContext(
  filtering: FilteringRules,
  toolDef: ToolDefinition,
  args: Record<string, unknown>,
  parameterAliases: Record<string, string[]>,
  operation?: OperationInfo
): FilteringContext {
  const aliasToCanonical = buildAliasToCanonical(parameterAliases);
  const toolParamGroups = buildToolParamGroups(toolDef, parameterAliases, aliasToCanonical);
  const filterKeys = Object.keys(filtering).filter(key => !isControlKey(key));
  
  validateFilterKeys(filterKeys, toolParamGroups, toolDef.parameters);
  
  const allowedByCanonical = buildAllowedByCanonical(
    filterKeys,
    filtering,
    aliasToCanonical,
    toolParamGroups
  );
  const applicableCanonicals = Array.from(allowedByCanonical.keys());
  const operationCategory = resolveOperationCategory(operation, args['action']);
  
  return {
    aliasToCanonical,
    toolParamGroups,
    allowedByCanonical,
    applicableCanonicals,
    operationCategory,
    hasAnyFilterParam: applicableCanonicals.some(canonical => {
      const group = toolParamGroups.get(canonical);
      return group ? getArgumentValue(args, group.names) !== undefined : false;
    }),
    permissions: {
      allowList: Object.prototype.hasOwnProperty.call(filtering, '_allow_list'),
      allowRead: Object.prototype.hasOwnProperty.call(filtering, '_allow_read')
    },
    action: typeof args['action'] === 'string' ? args['action'] : undefined
  };
}

function buildAllowedByCanonical(
  filterKeys: string[],
  filtering: FilteringRules,
  aliasToCanonical: Map<string, string>,
  toolParamGroups: Map<string, { names: string[] }>
): Map<string, string[]> {
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
  
  return allowedByCanonical;
}

function validateParameterValue(
  argValue: unknown,
  allowedValues: string[],
  canonical: string
): void {
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
    return;
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

function validateCanonicalParameter(
  ctx: FilteringContext,
  canonical: string,
  args: Record<string, unknown>,
  toolDef: ToolDefinition
): void {
  const allowedValues = ctx.allowedByCanonical.get(canonical) ?? [];
  const group = ctx.toolParamGroups.get(canonical);
  if (!group) {
    return;
  }
  
  const paramDefinition = toolDef.parameters[canonical];
  const argValue = getArgumentValue(args, group.names);
  const { operationCategory, permissions, hasAnyFilterParam, action } = ctx;
  const isList = operationCategory === 'list';
  const isRead = operationCategory === 'read';
  const isModify = operationCategory === 'modify';
  
  if (argValue === undefined) {
    if ((isList && permissions.allowList) || (isRead && permissions.allowRead)) {
      return;
    }
    if (action && isRequiredForAction(paramDefinition, action)) {
      throw new AuthorizationError(
        `Filter requires parameter '${canonical}' for tool '${toolDef.name}' action '${action}'.`
      );
    }
    if (isModify && hasAnyFilterParam) {
      return;
    }
    if (isList || isRead || isModify) {
      throw new AuthorizationError(
        `Filter requires parameter '${canonical}' for tool '${toolDef.name}'.`
      );
    }
    return;
  }
  
  // For list/read operations, allow _allow_list/_allow_read to relax value enforcement.
  // This enables "read/list any" access while keeping modify operations constrained to the allow-set.
  if ((isList && permissions.allowList) || (isRead && permissions.allowRead)) {
    return;
  }

  validateParameterValue(argValue, allowedValues, canonical);
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
  
  const ctx = prepareFilteringContext(filtering, toolDef, args, parameterAliases ?? {}, operation);
  
  if (ctx.applicableCanonicals.length === 0) {
    return;
  }

  if (ctx.operationCategory === 'modify' && !ctx.hasAnyFilterParam) {
    for (const canonical of ctx.applicableCanonicals) {
      const paramDefinition = toolDef.parameters[canonical];
      if (ctx.action && isRequiredForAction(paramDefinition, ctx.action)) {
        throw new AuthorizationError(
          `Filter requires parameter '${canonical}' for tool '${toolDef.name}' action '${ctx.action}'.`
        );
      }
    }
    throw new AuthorizationError(
      `Filter requires at least one of [${ctx.applicableCanonicals.join(', ')}] for tool '${toolDef.name}'.`
    );
  }
  
  for (const canonical of ctx.applicableCanonicals) {
    validateCanonicalParameter(ctx, canonical, args, toolDef);
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

function validateFilterKeys(
  filterKeys: string[],
  toolParamGroups: Map<string, { names: string[] }>,
  parameters: Record<string, ParameterDefinition>
): void {
  const allowedKeys = new Set<string>();
  for (const [canonical, group] of toolParamGroups.entries()) {
    allowedKeys.add(canonical);
    for (const name of group.names) {
      allowedKeys.add(name);
    }
  }
  for (const key of Object.keys(parameters)) {
    allowedKeys.add(key);
  }

  const unknownKeys = filterKeys.filter(key => !allowedKeys.has(key));
  if (unknownKeys.length === 0) {
    return;
  }
  const allowedList = Array.from(allowedKeys).sort().join(', ');
  throw new ValidationError(
    `Unknown filter key '${unknownKeys[0]}'. Allowed keys: ${allowedList}`
  );
}

function isRequiredForAction(paramDefinition: ParameterDefinition | undefined, action: string): boolean {
  if (!paramDefinition) {
    return false;
  }
  if (paramDefinition.required) {
    return true;
  }
  if (!paramDefinition.required_for || paramDefinition.required_for.length === 0) {
    return false;
  }
  return paramDefinition.required_for.includes(action);
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
