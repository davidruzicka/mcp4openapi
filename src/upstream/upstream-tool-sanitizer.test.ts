/**
 * Tests for upstream tool sanitizer
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '../core/logger.js';
import { sanitizeToolList, applyProviderToolPolicy, isToolAllowedByProviderPolicy, isValidUpstreamToolName } from './upstream-tool-sanitizer.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

function makeTool(name: string, description?: string): Tool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
  };
}

describe('sanitizeToolList', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  it('returns empty lists for empty input', () => {
    const result = sanitizeToolList([], logger);
    expect(result.tools).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it('passes through tool with valid name and safe description', () => {
    const tool = makeTool('valid_tool-1', 'Safe description');
    const result = sanitizeToolList([tool], logger);
    expect(result.tools).toEqual([tool]);
    expect(result.dropped).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('drops tool with invalid characters in name (angle bracket)', () => {
    const tool = makeTool('tool<inject>', 'ok');
    const result = sanitizeToolList([tool], logger);
    expect(result.tools).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toBe('invalid characters in tool name');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('drops tool with forbidden characters in description (script tag)', () => {
    const tool = makeTool('valid', 'has <script> tag');
    const result = sanitizeToolList([tool], logger);
    expect(result.tools).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].name).toBe('valid');
    expect(result.dropped[0].reason).toBe('forbidden characters in description');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('drops tool with space in name (spaces not in [a-zA-Z0-9_-])', () => {
    const tool = makeTool('has spaces', 'ok');
    const result = sanitizeToolList([tool], logger);
    expect(result.tools).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toBe('invalid characters in tool name');
  });

  it('handles mixed list: keeps safe, drops invalid', () => {
    const safe = makeTool('ok', 'fine');
    const bad = makeTool('bad!', 'ok');
    const result = sanitizeToolList([safe, bad], logger);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('ok');
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].name).toBe('bad!');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('drops tool with backtick in description', () => {
    const tool = makeTool('valid', 'has `backtick`');
    const result = sanitizeToolList([tool], logger);
    expect(result.tools).toEqual([]);
    expect(result.dropped[0].reason).toBe('forbidden characters in description');
  });

  it('drops tool with > in description', () => {
    const tool = makeTool('valid', 'hello > world');
    const result = sanitizeToolList([tool], logger);
    expect(result.tools).toEqual([]);
    expect(result.dropped[0].reason).toBe('forbidden characters in description');
  });

  it('passes tool with no description (undefined) if name is valid', () => {
    const tool = makeTool('no_desc_tool');
    const result = sanitizeToolList([tool], logger);
    expect(result.tools).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it('calls logger.warn once per dropped tool with truncated name and reason', () => {
    const tool1 = makeTool('bad!');
    const tool2 = makeTool('also bad@');
    sanitizeToolList([tool1, tool2], logger);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('drops tool with name exceeding 255 chars with reason "tool name too long"', () => {
    const longName = 'a'.repeat(256);
    const tool = makeTool(longName, 'ok');
    const result = sanitizeToolList([tool], logger);
    expect(result.tools).toEqual([]);
    expect(result.dropped[0].reason).toBe('tool name too long');
  });

  it('drops tool with description exceeding 2048 chars with reason "tool description too long"', () => {
    const longDesc = 'a'.repeat(2049);
    const tool = makeTool('valid_tool', longDesc);
    const result = sanitizeToolList([tool], logger);
    expect(result.tools).toEqual([]);
    expect(result.dropped[0].reason).toBe('tool description too long');
  });

  it('passes tool with description of exactly 2048 chars (boundary - should pass)', () => {
    const desc = 'a'.repeat(2048);
    const tool = makeTool('valid_tool', desc);
    const result = sanitizeToolList([tool], logger);
    expect(result.tools).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it('drops tool with description of 2049 chars (boundary + 1 - should drop)', () => {
    const desc = 'a'.repeat(2049);
    const tool = makeTool('valid_tool', desc);
    const result = sanitizeToolList([tool], logger);
    expect(result.tools).toHaveLength(0);
    expect(result.dropped[0].reason).toBe('tool description too long');
  });

  it('drops tool with empty string name with reason "invalid characters in tool name"', () => {
    const tool = makeTool('', 'ok');
    const result = sanitizeToolList([tool], logger);
    expect(result.tools).toEqual([]);
    expect(result.dropped[0].reason).toBe('invalid characters in tool name');
  });

  it('truncates dropped name to max 100 chars to prevent log injection', () => {
    const longName = 'a'.repeat(200);
    const tool = makeTool(longName + '!', 'ok'); // invalid char to trigger drop
    const result = sanitizeToolList([tool], logger);
    // The name itself is 201 chars; truncated to 100 + '...'
    expect(result.dropped[0].name.length).toBeLessThanOrEqual(103); // 100 + '...'
    expect(result.dropped[0].name).toMatch(/\.\.\.$/);
  });

  it('truncates dropped name for a 200-char tool name to 100 chars + ellipsis', () => {
    const longName = 'a'.repeat(256); // too long -> drops with "tool name too long"
    const result = sanitizeToolList([makeTool(longName)], logger);
    expect(result.dropped[0].name).toBe('a'.repeat(100) + '...');
  });

  it('sanitizes control characters in dropped tool name to prevent log injection', () => {
    const tool = makeTool('tool\nfake-log-entry');
    const result = sanitizeToolList([tool], logger);
    expect(result.dropped[0].name).not.toContain('\n');
    expect(result.dropped[0].name).toContain('\\n');
  });

  it('works without logger (no error thrown)', () => {
    const tool = makeTool('bad!');
    expect(() => sanitizeToolList([tool])).not.toThrow();
  });
});

describe('applyProviderToolPolicy', () => {
  const tools = [makeTool('alpha'), makeTool('beta'), makeTool('gamma')];

  it('returns all tools when no policy is given', () => {
    expect(applyProviderToolPolicy(tools, undefined)).toEqual(tools);
  });

  it('returns all tools when policy has no allow or deny', () => {
    expect(applyProviderToolPolicy(tools, {})).toEqual(tools);
  });

  it('filters to allow list only', () => {
    const result = applyProviderToolPolicy(tools, { allow: ['alpha', 'gamma'] });
    expect(result.map(t => t.name)).toEqual(['alpha', 'gamma']);
  });

  it('excludes tools in deny list', () => {
    const result = applyProviderToolPolicy(tools, { deny: ['beta'] });
    expect(result.map(t => t.name)).toEqual(['alpha', 'gamma']);
  });

  it('allow + deny: allow takes precedence, then deny applied', () => {
    const result = applyProviderToolPolicy(tools, { allow: ['alpha', 'beta'], deny: ['beta'] });
    expect(result.map(t => t.name)).toEqual(['alpha']);
  });

  it('returns empty list when allow list is empty', () => {
    expect(applyProviderToolPolicy(tools, { allow: [] })).toEqual([]);
  });

  it('returns all tools when deny list is empty', () => {
    expect(applyProviderToolPolicy(tools, { deny: [] })).toEqual(tools);
  });
});

describe('isValidUpstreamToolName', () => {
  it('accepts valid names with letters, digits, underscores, hyphens', () => {
    expect(isValidUpstreamToolName('valid_tool-1')).toBe(true);
    expect(isValidUpstreamToolName('A')).toBe(true);
    expect(isValidUpstreamToolName('abc-DEF_123')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidUpstreamToolName('')).toBe(false);
  });

  it('accepts name of exactly 255 chars (boundary - should pass)', () => {
    expect(isValidUpstreamToolName('a'.repeat(255))).toBe(true);
  });

  it('rejects name of 256 chars (boundary + 1 - should fail)', () => {
    expect(isValidUpstreamToolName('a'.repeat(256))).toBe(false);
  });

  it('rejects names with spaces', () => {
    expect(isValidUpstreamToolName('has space')).toBe(false);
  });

  it('rejects names with special characters', () => {
    expect(isValidUpstreamToolName('tool<inject>')).toBe(false);
    expect(isValidUpstreamToolName('tool!name')).toBe(false);
    expect(isValidUpstreamToolName('tool.name')).toBe(false);
  });

  it('rejects names with newline (log injection attempt)', () => {
    expect(isValidUpstreamToolName('tool\nfake-log')).toBe(false);
  });
});

describe('isToolAllowedByProviderPolicy', () => {
  it('allows all tools when no policy', () => {
    expect(isToolAllowedByProviderPolicy('any_tool', undefined)).toBe(true);
  });

  it('allows tool in allow list', () => {
    expect(isToolAllowedByProviderPolicy('alpha', { allow: ['alpha', 'beta'] })).toBe(true);
  });

  it('rejects tool not in allow list', () => {
    expect(isToolAllowedByProviderPolicy('gamma', { allow: ['alpha', 'beta'] })).toBe(false);
  });

  it('rejects tool in deny list', () => {
    expect(isToolAllowedByProviderPolicy('alpha', { deny: ['alpha'] })).toBe(false);
  });

  it('allows tool not in deny list', () => {
    expect(isToolAllowedByProviderPolicy('beta', { deny: ['alpha'] })).toBe(true);
  });

  it('rejects tool in both allow and deny (deny wins)', () => {
    expect(isToolAllowedByProviderPolicy('alpha', { allow: ['alpha'], deny: ['alpha'] })).toBe(false);
  });
});
