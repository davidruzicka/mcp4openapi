import { ValidationError } from '../core/errors.js';
import type {
  PromptDefinition,
  PromptMessageRole,
  PromptContentTemplate,
} from '../types/profile.js';

const TEMPLATE_TOKEN_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export interface RenderedPromptMessage {
  role: PromptMessageRole;
  content: PromptContentTemplate;
}

export interface RenderedPrompt {
  name: string;
  description?: string;
  messages: RenderedPromptMessage[];
}

export function renderPrompt(
  prompt: PromptDefinition,
  args: Record<string, unknown> = {}
): RenderedPrompt {
  const missingRequiredArguments = getMissingRequiredArguments(prompt, args);
  if (missingRequiredArguments.length > 0) {
    throw new ValidationError(
      `Prompt '${prompt.name}' is missing required arguments: ${missingRequiredArguments.join(', ')}`,
      { promptName: prompt.name, missingRequiredArguments }
    );
  }

  const messages = prompt.messages.map((message) => ({
    role: message.role,
    content: {
      type: 'text' as const,
      text: renderTextTemplate(message.content.text, args),
    },
  }));

  return {
    name: prompt.name,
    description: prompt.description,
    messages,
  };
}

function getMissingRequiredArguments(
  prompt: PromptDefinition,
  args: Record<string, unknown>
): string[] {
  const requiredArgumentNames = (prompt.arguments || [])
    .filter((argumentDefinition) => argumentDefinition.required)
    .map((argumentDefinition) => argumentDefinition.name);

  return requiredArgumentNames.filter((argumentName) => !(argumentName in args));
}

function renderTextTemplate(template: string, args: Record<string, unknown>): string {
  return template.replace(TEMPLATE_TOKEN_PATTERN, (_token, variableName: string) => {
    const rawValue = args[variableName];
    if (rawValue === undefined || rawValue === null) {
      return '';
    }
    return stringifyPromptValue(rawValue);
  });
}

function stringifyPromptValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}
