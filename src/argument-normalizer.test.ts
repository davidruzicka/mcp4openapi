import { describe, expect, it } from 'vitest'
import { normalizeArguments } from './argument-normalizer.js'
import type { ToolDefinition } from './types/profile.js'

describe('normalizeArguments', () => {
  it('maps object entries into an array using configured fields', () => {
    const toolDef: ToolDefinition = {
      name: 'create_content',
      description: 'Test tool',
      parameters: {
        customFields: {
          type: ['object', 'array'],
          description: 'Custom fields',
          properties: {},
          items: { type: 'object' },
          object_entries_to_array: {
            key_field: 'name',
            value_field: 'value',
            wrap_value_field: 'name',
          },
        },
      },
    }

    const result = normalizeArguments(toolDef, {
      customFields: {
        Type: 'Task',
        Priority: { name: 'Medium' },
      },
    })

    expect(result.customFields).toEqual([
      { name: 'Type', value: { name: 'Task' } },
      { name: 'Priority', value: { name: 'Medium' } },
    ])
  })

  it('leaves object-mapped fields unchanged when already an array', () => {
    const toolDef: ToolDefinition = {
      name: 'create_content',
      description: 'Test tool',
      parameters: {
        customFields: {
          type: ['object', 'array'],
          description: 'Custom fields',
          properties: {},
          items: { type: 'object' },
          object_entries_to_array: {
            key_field: 'name',
            value_field: 'value',
            wrap_value_field: 'name',
          },
        },
      },
    }

    const args = {
      customFields: [{ name: 'Type', value: { name: 'Task' } }],
    }

    const result = normalizeArguments(toolDef, args)

    expect(result.customFields).toEqual(args.customFields)
  })

  it('wraps array items into objects when configured', () => {
    const toolDef: ToolDefinition = {
      name: 'run_commands',
      description: 'Test tool',
      parameters: {
        issues: {
          type: 'array',
          description: 'Issue IDs',
          items: { type: 'string' },
          array_item_to_object: {
            key_field: 'id',
          },
        },
      },
    }

    const result = normalizeArguments(toolDef, {
      issues: ['ISSUE-1', { id: 'ISSUE-2' }],
    })

    expect(result.issues).toEqual([
      { id: 'ISSUE-1' },
      { id: 'ISSUE-2' },
    ])
  })

  it('keeps array items unchanged when no transformation applies', () => {
    const toolDef: ToolDefinition = {
      name: 'run_commands',
      description: 'Test tool',
      parameters: {
        issues: {
          type: 'array',
          description: 'Issue IDs',
          items: { type: 'string' },
          array_item_to_object: {
            key_field: 'id',
          },
        },
      },
    }

    const args = {
      issues: [{ id: 'ISSUE-1' }],
    }

    const result = normalizeArguments(toolDef, args)

    expect(result.issues).toEqual(args.issues)
  })
})
