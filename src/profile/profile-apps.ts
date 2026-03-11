import fs from 'fs/promises';
import path from 'path';
import { ValidationError } from '../core/errors.js';
import type {
  Profile,
  ResourceAppsDefinition,
  ResourceCompletionVariableDefinition,
  ResourceDefinition,
  ResourceFetchDefinition,
  ToolDefinition,
  ToolAppsDefinition,
} from '../types/profile.js';
import type { OpenAPIParser } from '../openapi/openapi-parser.js';

const INLINE_TEXT_MAX_BYTES = 16 * 1024;
const INVOCATION_TEXT_MAX_LENGTH = 80;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_COMPLETION_VALUES = 100;
const MAX_COMPLETION_VALUE_LENGTH = 256;
const MAX_RESULT_PATH_LENGTH = 256;
const TEXT_SAFE_MIME_PREFIXES = ['text/'];
const TEXT_SAFE_MIME_TYPES = new Set(['application/json']);
const READ_ONLY_HTTP_METHODS = new Set(['GET', 'HEAD']);
const TEMPLATE_VARIABLE_REGEX = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

export interface LoadedProfileAppsModel {
  fixedResources: LoadedResource[];
  templateResources: LoadedTemplateResource[];
  resourcesByUri: Map<string, LoadedResource>;
  templateResourcesByName: Map<string, LoadedTemplateResource>;
  templateResourcesByUriTemplate: Map<string, LoadedTemplateResource>;
  toolAppsByName: Map<string, LoadedToolAppsBinding>;
}

export interface LoadedResource {
  name: string;
  kind: 'static';
  uri: string;
  title?: string;
  description?: string;
  mimeType: string;
  text?: string;
  fetchStrategy?: LoadedResourceFetchStrategy;
  appsMeta?: Record<string, unknown>;
}

export interface LoadedTemplateResource {
  name: string;
  kind: 'template';
  uriTemplate: string;
  title?: string;
  description?: string;
  mimeType: string;
  staticText?: string;
  fetchStrategy?: LoadedResourceFetchStrategy;
  completion?: LoadedResourceCompletion;
  appsMeta?: Record<string, unknown>;
  variables: string[];
  matcher: RegExp;
}

export interface LoadedResourceFetchStrategy {
  source: 'operation' | 'composite';
  operation?: string;
  compositeTool?: string;
  parameterMapping: Record<string, string>;
  resultPath?: string;
  cacheTtlSeconds?: number;
  timeoutMs: number;
}

export interface LoadedResourceCompletion {
  variables: Record<string, LoadedCompletionVariable>;
}

export interface LoadedCompletionVariable {
  source: 'static' | 'operation' | 'composite_tool';
  values?: string[];
  operation?: string;
  compositeTool?: string;
  resultPath?: string;
  labelPath?: string;
  valuePath?: string;
  parameterMapping: Record<string, string>;
  timeoutMs: number;
  maxValues: number;
}

export interface LoadedToolAppsBinding {
  outputTemplateResourceUri?: string;
  outputTemplateResourceName?: string;
  templateParameterMapping?: Record<string, string>;
  meta: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

interface CreateLoadedProfileAppsModelOptions {
  profilePath: string;
  parser?: OpenAPIParser;
}

export async function createLoadedProfileAppsModel(
  profile: Profile,
  options: CreateLoadedProfileAppsModelOptions,
): Promise<LoadedProfileAppsModel | undefined> {
  const resources = profile.resources || [];
  const hasToolApps = profile.tools.some((tool) => !!tool.apps);
  if (resources.length === 0 && !hasToolApps) {
    return undefined;
  }

  const profileDir = path.dirname(options.profilePath);
  const resourceNames = new Set<string>();
  const resourceUris = new Set<string>();
  const resourceUriTemplates = new Set<string>();
  const fixedResources: LoadedResource[] = [];
  const templateResources: LoadedTemplateResource[] = [];
  const resourcesByUri = new Map<string, LoadedResource>();
  const templateResourcesByName = new Map<string, LoadedTemplateResource>();
  const templateResourcesByUriTemplate = new Map<string, LoadedTemplateResource>();

  for (const [index, resource] of resources.entries()) {
    const resourcePath = `resources[${index}]`;
    validateUniqueResourceName(resource, resourceNames, resourcePath);
    validateMimeType(resource.mime_type, `${resourcePath}.mime_type`);

    if (resource.kind === 'static') {
      const loaded = await loadStaticResource(resource, profileDir, resourcePath, options.parser, profile);
      if (resourceUris.has(loaded.uri)) {
        throw appsValidationError(
          `Duplicate resource uri '${loaded.uri}'`,
          `${resourcePath}.uri`,
          'apps_resource_duplicate_uri',
          loaded.uri,
        );
      }
      resourceUris.add(loaded.uri);
      fixedResources.push(loaded);
      resourcesByUri.set(loaded.uri, loaded);
      continue;
    }

    const loaded = await loadTemplateResource(resource, profileDir, resourcePath, options.parser, profile);
    if (resourceUriTemplates.has(loaded.uriTemplate)) {
      throw appsValidationError(
        `Duplicate resource uri_template '${loaded.uriTemplate}'`,
        `${resourcePath}.uri_template`,
        'apps_resource_duplicate_uri_template',
        loaded.uriTemplate,
      );
    }
    resourceUriTemplates.add(loaded.uriTemplate);
    templateResources.push(loaded);
    templateResourcesByName.set(loaded.name, loaded);
    templateResourcesByUriTemplate.set(loaded.uriTemplate, loaded);
  }

  const toolAppsByName = new Map<string, LoadedToolAppsBinding>();
  for (const [index, tool] of profile.tools.entries()) {
    const binding = buildToolAppsBinding(
      tool,
      index,
      profile,
      resourcesByUri,
      templateResourcesByUriTemplate,
    );
    if (binding) {
      toolAppsByName.set(tool.name, binding);
    }
  }

  return {
    fixedResources,
    templateResources,
    resourcesByUri,
    templateResourcesByName,
    templateResourcesByUriTemplate,
    toolAppsByName,
  };
}

function validateUniqueResourceName(resource: ResourceDefinition, resourceNames: Set<string>, pathRef: string): void {
  if (resourceNames.has(resource.name)) {
    throw appsValidationError(
      `Duplicate resource name '${resource.name}'`,
      `${pathRef}.name`,
      'apps_resource_duplicate_name',
      resource.name,
    );
  }
  resourceNames.add(resource.name);
}

async function loadStaticResource(
  resource: ResourceDefinition,
  profileDir: string,
  resourcePath: string,
  parser: OpenAPIParser | undefined,
  profile: Profile,
): Promise<LoadedResource> {
  if (!resource.uri) {
    throw appsValidationError(
      'Static resource requires uri',
      `${resourcePath}.uri`,
      'apps_resource_missing_content',
    );
  }
  validateUri(resource.uri, `${resourcePath}.uri`, 'apps_resource_invalid_uri');
  const content = await resolveResourceContent(resource, profileDir, resourcePath, parser, profile, false, []);
  return {
    name: resource.name,
    kind: 'static',
    uri: resource.uri,
    title: resource.title,
    description: resource.description,
    mimeType: resource.mime_type,
    text: content.text,
    fetchStrategy: content.fetchStrategy,
    appsMeta: normalizeResourceAppsMeta(resource.apps, `${resourcePath}.apps`),
  };
}

async function loadTemplateResource(
  resource: ResourceDefinition,
  profileDir: string,
  resourcePath: string,
  parser: OpenAPIParser | undefined,
  profile: Profile,
): Promise<LoadedTemplateResource> {
  if (!resource.uri_template) {
    throw appsValidationError(
      'Template resource requires uri_template',
      `${resourcePath}.uri_template`,
      'apps_resource_missing_content',
    );
  }
  const { variables, matcher } = compileUriTemplate(resource.uri_template, `${resourcePath}.uri_template`);
  const content = await resolveResourceContent(resource, profileDir, resourcePath, parser, profile, true, variables);
  const completion = resource.completion
    ? loadCompletion(resource.completion, variables, `${resourcePath}.completion`, parser, profile)
    : undefined;

  return {
    name: resource.name,
    kind: 'template',
    uriTemplate: resource.uri_template,
    title: resource.title,
    description: resource.description,
    mimeType: resource.mime_type,
    staticText: content.text,
    fetchStrategy: content.fetchStrategy,
    completion,
    appsMeta: normalizeResourceAppsMeta(resource.apps, `${resourcePath}.apps`),
    variables,
    matcher,
  };
}

async function resolveResourceContent(
  resource: ResourceDefinition,
  profileDir: string,
  resourcePath: string,
  parser: OpenAPIParser | undefined,
  profile: Profile,
  allowTemplateWithoutContent = false,
  runtimeSourceKeys: string[] = [],
): Promise<{ text?: string; fetchStrategy?: LoadedResourceFetchStrategy }> {
  const contentSourceCount = [resource.file_path, resource.inline_text, resource.fetch].filter((value) => value !== undefined).length;
  if (contentSourceCount > 1) {
    throw appsValidationError(
      'Resource must declare exactly one of file_path, inline_text, or fetch',
      resourcePath,
      'apps_resource_content_conflict',
    );
  }
  if (contentSourceCount === 0 && !allowTemplateWithoutContent) {
    throw appsValidationError(
      'Resource must declare one of file_path, inline_text, or fetch',
      resourcePath,
      'apps_resource_missing_content',
    );
  }

  if (resource.inline_text !== undefined) {
    validateInlineText(resource.inline_text, `${resourcePath}.inline_text`);
    return { text: resource.inline_text };
  }

  if (resource.file_path !== undefined) {
    const resolvedPath = resolveProfileResourcePath(profileDir, resource.file_path, `${resourcePath}.file_path`);
    try {
      const fileContent = await fs.readFile(resolvedPath, 'utf-8');
      return { text: fileContent };
    } catch {
      throw appsValidationError(
        `Resource file not found or unreadable: ${resource.file_path}`,
        `${resourcePath}.file_path`,
        'apps_resource_file_not_found',
        resource.file_path,
      );
    }
  }

  if (resource.fetch) {
    return {
      fetchStrategy: loadFetchStrategy(resource.fetch, `${resourcePath}.fetch`, parser, profile, runtimeSourceKeys),
    };
  }

  return {};
}

function resolveProfileResourcePath(profileDir: string, resourceFilePath: string, pathRef: string): string {
  const resolvedPath = path.resolve(profileDir, resourceFilePath);
  const relativePath = path.relative(profileDir, resolvedPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw appsValidationError(
      `Resource file_path must stay within the profile directory: ${resourceFilePath}`,
      pathRef,
      'apps_resource_file_not_found',
      resourceFilePath,
    );
  }
  return resolvedPath;
}

function loadFetchStrategy(
  fetchDefinition: ResourceFetchDefinition,
  pathRef: string,
  parser: OpenAPIParser | undefined,
  profile: Profile,
  runtimeSourceKeys: string[],
): LoadedResourceFetchStrategy {
  validatePathExpression(fetchDefinition.result_path, `${pathRef}.result_path`, 'apps_resource_invalid_fetch_reference');

  if (fetchDefinition.source === 'operation') {
    if (!fetchDefinition.operation) {
      throw appsValidationError(
        'Operation-backed fetch requires operation',
        `${pathRef}.operation`,
        'apps_resource_invalid_fetch_reference',
      );
    }
    const operation = parser?.getOperation(fetchDefinition.operation);
    if (parser && !operation) {
      throw appsValidationError(
        `Unknown operation '${fetchDefinition.operation}'`,
        `${pathRef}.operation`,
        'apps_resource_invalid_fetch_reference',
        fetchDefinition.operation,
      );
    }
    if (operation && !READ_ONLY_HTTP_METHODS.has(operation.method)) {
      throw appsValidationError(
        `Operation '${fetchDefinition.operation}' must use GET or HEAD`,
        `${pathRef}.operation`,
        'apps_resource_invalid_fetch_reference',
        fetchDefinition.operation,
      );
    }
  }

  if (fetchDefinition.source === 'composite') {
    if (!fetchDefinition.composite_tool) {
      throw appsValidationError(
        'Composite-backed fetch requires composite_tool',
        `${pathRef}.composite_tool`,
        'apps_resource_invalid_fetch_reference',
      );
    }
    const tool = profile.tools.find((candidate) => candidate.name === fetchDefinition.composite_tool);
    if (!tool?.composite || !tool.steps) {
      throw appsValidationError(
        `Unknown composite tool '${fetchDefinition.composite_tool}'`,
        `${pathRef}.composite_tool`,
        'apps_resource_invalid_fetch_reference',
        fetchDefinition.composite_tool,
      );
    }
    for (const step of tool.steps) {
      const [method] = step.call.split(' ');
      if (!READ_ONLY_HTTP_METHODS.has(method.toUpperCase())) {
        throw appsValidationError(
          `Composite tool '${tool.name}' must contain only GET/HEAD steps`,
          `${pathRef}.composite_tool`,
          'apps_resource_invalid_fetch_reference',
          fetchDefinition.composite_tool,
        );
      }
    }
  }

  validateParameterMapping(
    fetchDefinition.parameter_mapping,
    new Set(runtimeSourceKeys),
    `${pathRef}.parameter_mapping`,
    'apps_resource_invalid_fetch_reference',
  );

  return {
    source: fetchDefinition.source,
    operation: fetchDefinition.operation,
    compositeTool: fetchDefinition.composite_tool,
    parameterMapping: fetchDefinition.parameter_mapping || {},
    resultPath: fetchDefinition.result_path,
    cacheTtlSeconds: fetchDefinition.cache_ttl_seconds,
    timeoutMs: FETCH_TIMEOUT_MS,
  };
}

function loadCompletion(
  completion: NonNullable<ResourceDefinition['completion']>,
  templateVariables: string[],
  pathRef: string,
  parser: OpenAPIParser | undefined,
  profile: Profile,
): LoadedResourceCompletion {
  const variables = Object.create(null) as Record<string, LoadedCompletionVariable>;
  const templateVariableSet = new Set(templateVariables);

  for (const [variableName, definition] of Object.entries(completion.variables)) {
    if (!templateVariableSet.has(variableName)) {
      throw appsValidationError(
        `Completion variable '${variableName}' does not exist in uri_template`,
        `${pathRef}.variables.${variableName}`,
        'apps_resource_invalid_completion_definition',
        variableName,
      );
    }

    variables[variableName] = loadCompletionVariable(
      definition,
      `${pathRef}.variables.${variableName}`,
      parser,
      profile,
      templateVariables,
    );
  }

  return { variables };
}

function loadCompletionVariable(
  definition: ResourceCompletionVariableDefinition,
  pathRef: string,
  parser: OpenAPIParser | undefined,
  profile: Profile,
  templateVariables: string[],
): LoadedCompletionVariable {
  if (definition.source === 'static') {
    const uniqueValues = new Set(definition.values || []);
    if (!definition.values || definition.values.length === 0 || uniqueValues.size !== definition.values.length) {
      throw appsValidationError(
        'Static completion values must be non-empty and unique',
        `${pathRef}.values`,
        'apps_resource_invalid_completion_definition',
        definition.values,
      );
    }
    for (const value of definition.values) {
      if (value.length > MAX_COMPLETION_VALUE_LENGTH) {
        throw appsValidationError(
          'Static completion value is too long',
          `${pathRef}.values`,
          'apps_resource_invalid_completion_definition',
          value,
        );
      }
    }
    return {
      source: 'static',
      values: definition.values,
      parameterMapping: {},
      timeoutMs: FETCH_TIMEOUT_MS,
      maxValues: MAX_COMPLETION_VALUES,
    };
  }

  validatePathExpression(definition.result_path, `${pathRef}.result_path`, 'apps_resource_invalid_completion_definition');
  validatePathExpression(definition.label_path, `${pathRef}.label_path`, 'apps_resource_invalid_completion_definition');
  validatePathExpression(definition.value_path, `${pathRef}.value_path`, 'apps_resource_invalid_completion_definition');

  if (definition.source === 'operation') {
    if (!definition.operation) {
      throw appsValidationError(
        'Operation-backed completion requires operation',
        `${pathRef}.operation`,
        'apps_resource_invalid_completion_definition',
      );
    }
    const operation = parser?.getOperation(definition.operation);
    if (parser && !operation) {
      throw appsValidationError(
        `Completion operation '${definition.operation}' must exist and be GET/HEAD`,
        `${pathRef}.operation`,
        'apps_resource_invalid_completion_definition',
        definition.operation,
      );
    }
    if (operation && !READ_ONLY_HTTP_METHODS.has(operation.method)) {
      throw appsValidationError(
        `Completion operation '${definition.operation}' must exist and be GET/HEAD`,
        `${pathRef}.operation`,
        'apps_resource_invalid_completion_definition',
        definition.operation,
      );
    }
  }

  if (definition.source === 'composite_tool') {
    if (!definition.composite_tool) {
      throw appsValidationError(
        'Composite-backed completion requires composite_tool',
        `${pathRef}.composite_tool`,
        'apps_resource_invalid_completion_definition',
      );
    }
    const tool = profile.tools.find((candidate) => candidate.name === definition.composite_tool);
    if (!tool?.composite || !tool.steps) {
      throw appsValidationError(
        `Unknown composite tool '${definition.composite_tool}'`,
        `${pathRef}.composite_tool`,
        'apps_resource_invalid_completion_definition',
        definition.composite_tool,
      );
    }
    for (const step of tool.steps) {
      const [method] = step.call.split(' ');
      if (!READ_ONLY_HTTP_METHODS.has(method.toUpperCase())) {
        throw appsValidationError(
          `Completion composite tool '${tool.name}' must contain only GET/HEAD steps`,
          `${pathRef}.composite_tool`,
          'apps_resource_invalid_completion_definition',
          definition.composite_tool,
        );
      }
    }
  }

  if (!definition.value_path && !definition.label_path) {
    throw appsValidationError(
      'Operation-backed and composite-backed completion requires value_path or label_path',
      pathRef,
      'apps_resource_invalid_completion_definition',
    );
  }

  validateParameterMapping(
    definition.parameter_mapping,
    new Set(templateVariables),
    `${pathRef}.parameter_mapping`,
    'apps_resource_invalid_completion_definition',
  );

  return {
    source: definition.source,
    operation: definition.operation,
    compositeTool: definition.composite_tool,
    resultPath: definition.result_path,
    labelPath: definition.label_path,
    valuePath: definition.value_path,
    parameterMapping: definition.parameter_mapping || {},
    timeoutMs: FETCH_TIMEOUT_MS,
    maxValues: MAX_COMPLETION_VALUES,
  };
}

function buildToolAppsBinding(
  tool: ToolDefinition,
  toolIndex: number,
  profile: Profile,
  resourcesByUri: Map<string, LoadedResource>,
  templateResourcesByUriTemplate: Map<string, LoadedTemplateResource>,
): LoadedToolAppsBinding | undefined {
  if (!tool.apps) {
    return undefined;
  }

  const pathRef = `tools[${toolIndex}].apps`;
  validateInvocationText(tool.apps, pathRef);
  ensureJsonSerializable(tool.apps.custom_meta, `${pathRef}.custom_meta`, 'apps_tool_invalid_invocation_text');
  ensureJsonSerializable(tool.apps.annotations, `${pathRef}.annotations`, 'apps_tool_invalid_invocation_text');

  let outputTemplateResourceName: string | undefined;
  let templateParameterMapping: Record<string, string> | undefined;
  if (tool.apps.output_template_resource_uri) {
    const staticResource = resourcesByUri.get(tool.apps.output_template_resource_uri);
    const templateResource = templateResourcesByUriTemplate.get(tool.apps.output_template_resource_uri);
    if (!staticResource && !templateResource) {
      throw appsValidationError(
        `Tool '${tool.name}' references unknown resource '${tool.apps.output_template_resource_uri}'`,
        `${pathRef}.output_template_resource_uri`,
        'apps_tool_missing_resource_reference',
        tool.apps.output_template_resource_uri,
      );
    }
    outputTemplateResourceName = staticResource?.name || templateResource?.name;

    if (templateResource) {
      const toolParamNames = new Set(Object.keys(tool.parameters));
      const explicitMappings = tool.apps.template_parameter_mapping || {};
      for (const [variable, parameterName] of Object.entries(explicitMappings)) {
        if (!templateResource.variables.includes(variable)) {
          throw appsValidationError(
            `Tool '${tool.name}' mapping references unknown template variable '${variable}'`,
            `${pathRef}.template_parameter_mapping.${variable}`,
            'apps_tool_invalid_template_mapping',
            variable,
          );
        }
        if (!toolParamNames.has(parameterName)) {
          throw appsValidationError(
            `Tool '${tool.name}' mapping references unknown parameter '${parameterName}'`,
            `${pathRef}.template_parameter_mapping.${variable}`,
            'apps_tool_invalid_template_mapping',
            parameterName,
          );
        }
      }
      for (const variable of templateResource.variables) {
        if (explicitMappings[variable]) {
          continue;
        }
        if (toolParamNames.has(variable)) {
          continue;
        }
        const aliases = profile.parameter_aliases?.[variable] || [];
        if (aliases.some((alias) => toolParamNames.has(alias))) {
          continue;
        }
        throw appsValidationError(
          `Tool '${tool.name}' cannot derive template variable '${variable}' from its parameters`,
          `${pathRef}.output_template_resource_uri`,
          'apps_tool_invalid_template_mapping',
          variable,
        );
      }
      templateParameterMapping = Object.keys(explicitMappings).length > 0 ? explicitMappings : undefined;
    }
  }

  const meta: Record<string, unknown> = {};
  if (tool.apps.output_template_resource_uri) {
    meta['openai/outputTemplate'] = tool.apps.output_template_resource_uri;
  }
  if (tool.apps.widget_accessible !== undefined) {
    meta['openai/widgetAccessible'] = tool.apps.widget_accessible;
  }
  const invocation = tool.apps.invocation_text || tool.apps.tool_invocation_message;
  if (invocation?.invoking) {
    meta['openai/toolInvocation/invoking'] = invocation.invoking;
  }
  if (invocation?.invoked) {
    meta['openai/toolInvocation/invoked'] = invocation.invoked;
  }
  if (tool.apps.custom_meta) {
    Object.assign(meta, tool.apps.custom_meta);
  }

  return {
    outputTemplateResourceUri: tool.apps.output_template_resource_uri,
    outputTemplateResourceName,
    templateParameterMapping,
    meta,
    annotations: tool.apps.annotations,
  };
}

function normalizeResourceAppsMeta(apps: ResourceAppsDefinition | undefined, pathRef: string): Record<string, unknown> | undefined {
  if (!apps) {
    return undefined;
  }
  ensureJsonSerializable(apps.custom_meta, `${pathRef}.custom_meta`, 'apps_resource_invalid_fetch_reference');
  const meta: Record<string, unknown> = {};
  if (apps.widget_description) {
    meta['openai/widgetDescription'] = apps.widget_description;
  }
  if (apps.widget_prefers_border !== undefined) {
    meta['openai/widgetPrefersBorder'] = apps.widget_prefers_border;
  }
  if (apps.widget_csp) {
    meta['openai/widgetCSP'] = apps.widget_csp;
  }
  if (apps.custom_meta) {
    Object.assign(meta, apps.custom_meta);
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function validateInlineText(value: string, pathRef: string): void {
  const sizeBytes = Buffer.byteLength(value, 'utf8');
  if (sizeBytes > INLINE_TEXT_MAX_BYTES) {
    throw appsValidationError(
      `inline_text exceeds ${INLINE_TEXT_MAX_BYTES} bytes`,
      pathRef,
      'apps_resource_content_conflict',
      sizeBytes,
    );
  }
}

function validatePathExpression(value: string | undefined, pathRef: string, code: string): void {
  if (!value) {
    return;
  }
  if (value.length > MAX_RESULT_PATH_LENGTH) {
    throw appsValidationError(
      'Path expression is too long',
      pathRef,
      code,
      value,
    );
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)) {
    throw appsValidationError(
      `Invalid path expression '${value}'`,
      pathRef,
      code,
      value,
    );
  }
}

function validateParameterMapping(
  mapping: Record<string, string> | undefined,
  allowedSourceKeys: Set<string>,
  pathRef: string,
  code: string,
): void {
  if (!mapping) {
    return;
  }

  for (const [targetKey, sourceKey] of Object.entries(mapping)) {
    if (!targetKey) {
      throw appsValidationError('Parameter mapping target key must be non-empty', pathRef, code, targetKey);
    }
    if (!sourceKey || !allowedSourceKeys.has(sourceKey)) {
      throw appsValidationError(
        `Parameter mapping source '${sourceKey}' is not allowed`,
        `${pathRef}.${targetKey}`,
        code,
        sourceKey,
      );
    }
  }
}

function validateMimeType(mimeType: string, pathRef: string): void {
  if (!TEXT_SAFE_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) && !TEXT_SAFE_MIME_TYPES.has(mimeType)) {
    throw appsValidationError(
      `Unsupported mime_type '${mimeType}'`,
      pathRef,
      'apps_resource_invalid_mime_type',
      mimeType,
    );
  }
}

function validateUri(uri: string, pathRef: string, code: string): void {
  try {
    const parsed = new URL(uri);
    if (!parsed.protocol) {
      throw new Error('missing protocol');
    }
  } catch {
    throw appsValidationError(
      `Invalid uri '${uri}'`,
      pathRef,
      code,
      uri,
    );
  }
}

function compileUriTemplate(uriTemplate: string, pathRef: string): { variables: string[]; matcher: RegExp } {
  const variables: string[] = [];
  let lastIndex = 0;
  let regexSource = '^';

  for (const match of uriTemplate.matchAll(TEMPLATE_VARIABLE_REGEX)) {
    const index = match.index ?? 0;
    regexSource += escapeRegExp(uriTemplate.slice(lastIndex, index));
    regexSource += '([^/?#]+)';
    lastIndex = index + match[0].length;
    const variable = match[1];
    if (variables.includes(variable)) {
      throw appsValidationError(
        `Duplicate template variable '${variable}'`,
        pathRef,
        'apps_resource_invalid_uri_template',
        uriTemplate,
      );
    }
    variables.push(variable);
  }

  regexSource += escapeRegExp(uriTemplate.slice(lastIndex));
  regexSource += '$';

  const unmatchedOpen = uriTemplate.includes('{') && variables.length === 0;
  const braceCount = (uriTemplate.match(/[{}]/g) || []).length;
  if (unmatchedOpen || braceCount % 2 !== 0) {
    throw appsValidationError(
      `Invalid uri_template '${uriTemplate}'`,
      pathRef,
      'apps_resource_invalid_uri_template',
      uriTemplate,
    );
  }

  try {
    return { variables, matcher: new RegExp(regexSource) };
  } catch {
    throw appsValidationError(
      `Invalid uri_template '${uriTemplate}'`,
      pathRef,
      'apps_resource_invalid_uri_template',
      uriTemplate,
    );
  }
}

function validateInvocationText(apps: ToolAppsDefinition, pathRef: string): void {
  const entries = [
    ['invoking', apps.invocation_text?.invoking ?? apps.tool_invocation_message?.invoking],
    ['invoked', apps.invocation_text?.invoked ?? apps.tool_invocation_message?.invoked],
  ] as const;

  for (const [key, value] of entries) {
    if (value && value.length > INVOCATION_TEXT_MAX_LENGTH) {
      throw appsValidationError(
        `Tool invocation text '${key}' exceeds ${INVOCATION_TEXT_MAX_LENGTH} characters`,
        `${pathRef}.${key}`,
        'apps_tool_invalid_invocation_text',
        value,
      );
    }
  }
}

function ensureJsonSerializable(value: unknown, pathRef: string, code: string): void {
  if (value === undefined) {
    return;
  }
  try {
    JSON.stringify(value);
  } catch {
    throw appsValidationError(
      'Value must be JSON serializable',
      pathRef,
      code,
    );
  }
}

function appsValidationError(message: string, pathRef: string, code: string, value?: unknown): ValidationError {
  return new ValidationError(message, {
    path: pathRef,
    code,
    reference: 'mcp-apps',
    ...(value !== undefined ? { value } : {}),
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getNestedValue(input: unknown, resultPath?: string): unknown {
  if (!resultPath) {
    return input;
  }
  const parts = resultPath.split('.').filter(Boolean);
  let current = input;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function extractTemplateVariables(resource: LoadedTemplateResource, uri: string): Record<string, string> | undefined {
  const match = resource.matcher.exec(uri);
  if (!match) {
    return undefined;
  }
  return resource.variables.reduce<Record<string, string>>((result, variable, index) => {
    result[variable] = decodeURIComponent(match[index + 1]);
    return result;
  }, {});
}
