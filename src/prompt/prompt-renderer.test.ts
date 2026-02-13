import { describe, expect, it } from 'vitest';
import { ValidationError } from '../core/errors.js';
import type { PromptDefinition } from '../types/profile.js';
import { renderPrompt } from './prompt-renderer.js';

describe('renderPrompt', () => {
  const basePrompt: PromptDefinition = {
    name: 'summarize_issue',
    description: 'Create short issue summary',
    arguments: [
      { name: 'issue_title', required: true },
      { name: 'priority', required: true },
      { name: 'assignee', required: false },
    ],
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Issue {{issue_title}} has priority {{priority}}. Assignee: {{assignee}}.',
        },
      },
    ],
  };

  it('renders prompt text with provided arguments', () => {
    const rendered = renderPrompt(basePrompt, {
      issue_title: 'Fix OAuth callback',
      priority: 'high',
      assignee: 'alice',
    });

    expect(rendered.name).toBe('summarize_issue');
    expect(rendered.description).toBe('Create short issue summary');
    expect(rendered.messages).toHaveLength(1);
    expect(rendered.messages[0].content.text).toContain('Fix OAuth callback');
    expect(rendered.messages[0].content.text).toContain('high');
    expect(rendered.messages[0].content.text).toContain('alice');
  });

  it('stringifies primitive and object values deterministically', () => {
    const prompt: PromptDefinition = {
      name: 'format_values',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'count={{count}},enabled={{enabled}},meta={{meta}}',
          },
        },
      ],
    };

    const rendered = renderPrompt(prompt, {
      count: 3,
      enabled: false,
      meta: { source: 'api' },
    });

    expect(rendered.messages[0].content.text).toBe('count=3,enabled=false,meta={"source":"api"}');
  });

  it('throws ValidationError when required arguments are missing', () => {
    expect(() => renderPrompt(basePrompt, { issue_title: 'Fix OAuth callback' })).toThrow(ValidationError);

    try {
      renderPrompt(basePrompt, { issue_title: 'Fix OAuth callback' });
      throw new Error('Expected renderPrompt to throw ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toContain('priority');
    }
  });

  it('keeps required check strict by key presence and renders null or undefined as empty string', () => {
    const rendered = renderPrompt(basePrompt, {
      issue_title: 'Fix OAuth callback',
      priority: null,
      assignee: undefined,
    });

    expect(rendered.messages[0].content.text).toContain('priority .');
    expect(rendered.messages[0].content.text).toContain('Assignee: .');
  });

  it('does not treat inherited prototype properties as provided required arguments', () => {
    const prototypeKeyPrompt: PromptDefinition = {
      name: 'prototype_key_prompt',
      arguments: [{ name: 'constructor', required: true }],
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: 'Constructor: {{constructor}}' },
        },
      ],
    };

    expect(() => renderPrompt(prototypeKeyPrompt, {})).toThrow(ValidationError);
  });
});
