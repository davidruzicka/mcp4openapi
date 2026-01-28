import type { ParameterDefinition, ToolDefinition } from './types/profile.js'

type NormalizedArguments = Record<string, unknown>

export function normalizeArguments(
  toolDef: ToolDefinition,
  args: Record<string, unknown>
): NormalizedArguments {
  const normalized: NormalizedArguments = { ...args }

  for (const [paramName, paramDef] of Object.entries(toolDef.parameters)) {
    const value = normalized[paramName]
    if (value === undefined) {
      continue
    }

    const mappedEntries = normalizeObjectEntries(paramDef, value)
    if (mappedEntries !== undefined) {
      normalized[paramName] = mappedEntries
      continue
    }

    const mappedArrayItems = normalizeArrayItems(paramDef, value)
    if (mappedArrayItems !== undefined) {
      normalized[paramName] = mappedArrayItems
    }
  }

  return normalized
}

export function applyParameterDefaults(
  toolDef: ToolDefinition,
  args: Record<string, unknown>
): NormalizedArguments {
  const normalized: NormalizedArguments = { ...args }

  for (const [paramName, paramDef] of Object.entries(toolDef.parameters)) {
    if (normalized[paramName] === undefined && paramDef.default !== undefined) {
      normalized[paramName] = paramDef.default
    }
  }

  return normalized
}

function normalizeObjectEntries(
  paramDef: ParameterDefinition,
  value: unknown
): unknown[] | undefined {
  if (!paramDef.object_entries_to_array) {
    return undefined
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const { key_field, value_field, wrap_value_field } = paramDef.object_entries_to_array
  const entries = Object.entries(value as Record<string, unknown>)

  return entries.map(([key, entryValue]) => ({
    [key_field]: key,
    [value_field]: wrapObjectValue(entryValue, wrap_value_field),
  }))
}

function wrapObjectValue(value: unknown, wrapValueField?: string): unknown {
  if (!wrapValueField) {
    return value
  }

  if (typeof value === 'object' && value !== null) {
    return value
  }

  return { [wrapValueField]: value }
}

function normalizeArrayItems(
  paramDef: ParameterDefinition,
  value: unknown
): unknown[] | undefined {
  if (!paramDef.array_item_to_object) {
    return undefined
  }

  if (!Array.isArray(value)) {
    return undefined
  }

  const { key_field } = paramDef.array_item_to_object

  return value.map(item => {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      return item
    }

    if (['string', 'number', 'boolean'].includes(typeof item)) {
      return { [key_field]: item }
    }

    return item
  })
}
